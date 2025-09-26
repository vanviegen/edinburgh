const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// EOD marker for container parsing
const EOD = Symbol('EOD');

const BASE64_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const BASE64_LOOKUP = new Uint8Array(128).fill(255); // Use 255 as invalid marker;
for (let i = 0; i < BASE64_CHARS.length; ++i) BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;

const COLORS = ['\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[35m']; // green, yellow, blue, magenta
const RESET_COLOR = '\x1b[0m';
const ERROR_COLOR = '\x1b[31m'; // red

let toStringTermCount = 0;
let useExtendedLogging = !!process.env.DATAPACK_EXTENDED_LOGGING;

/**
 * A byte buffer for efficient reading and writing of primitive values and bit sequences.
 * 
 * The DataPack class provides methods for serializing and deserializing various data types
 * including numbers, strings, bit sequences, and other primitive values to/from byte buffers.
 * It supports both reading and writing operations with automatic buffer management.
 */

export class DataPack {
    private buffer: Uint8Array;
    private dataView?: DataView;

    public readPos: number = 0;
    public writePos: number = 0;
    
    /**
     * Backward compatibility: Access to the internal buffer
     */
    get _buffer(): Uint8Array {
        return this.buffer;
    }

    /**
     * Create a new DataPack instance.
     * @param data - Optional initial data as Uint8Array or buffer size as number.
     */
    constructor(data: Uint8Array | number = 3900) {
        if (data instanceof Uint8Array) {
            this.buffer = data;
            this.writePos = data.length;
        } else {
            this.buffer = new Uint8Array(data);
        }
    }

    /**
     * Helper function to write a multi-byte integer with length prefix
     * @param value - The value to write
     * @param headerType - The type bits (0-7) for the header
     * @param invertBytes - Whether to invert bytes (for negative numbers)
     * @param invertByteCount - Whether to invert the byte count (for type 0)
     */
    private writeMultiByteNumber(value: number, headerType: number, invertBytes: boolean = false, invertByteCount: boolean = false): void {
        let byteCount = 0;
        let temp = value;
        while (temp > 0) {
            byteCount++;
            temp = Math.floor(temp / 256);
        }
        
        const encodedByteCount = invertByteCount ? ((~byteCount) & 0x1F) : byteCount;
        this.buffer[this.writePos++] = (headerType << 5) | encodedByteCount;
        
        let max = 1;
        for (let j = 0; j < byteCount; j++) max *= 256;
        for (let i = 0; i < byteCount; i++) {
            max = Math.floor(max / 256);
            let byte = Math.floor(value / max) % 256;
            if (invertBytes) byte ^= 0xFF;
            this.buffer[this.writePos++] = byte;
        }
    }

    /**
     * Helper function to read a multi-byte integer with length prefix
     * @param byteCount - Number of bytes to read
     * @param invertBytes - Whether to invert bytes (for negative numbers)
     * @returns The read value
     */
    private readMultiByteNumber(byteCount: number, invertBytes: boolean = false): number {
        if (this.readPos + byteCount > this.writePos) this.notEnoughData('number');
        let value = 0;
        let multiplier = 1;
        for (let i = byteCount - 1; i >= 0; i--) {
            let byte = this.buffer[this.readPos + i];
            if (invertBytes) byte ^= 0xFF;
            value += byte * multiplier;
            multiplier *= 256;
        }
        this.readPos += byteCount;
        return value;
    }

    private notEnoughData(type: string): never {
        throw new Error(`Not enough data to read a ${type} at position ${this.readPos} in\n${this.toString(true)}`);
    }

    /**
     * Each data item starts with a single byte. The high 3 bits indicate the type.
     * The low 5 bits indicate a size or a subtype, depending on the type.
     *
     * 0: negative integer (byte count encoded as bitwise NOT in lower bits)
     * 1: small integer 0..31 (encoded in lower bits)
     * 2: small integer 32...63 (encoded in lower bits)
     * 3: integer (byte count encoded in lower bits)
     * 4:
     *   0: float64 (8 bytes follow)
     *   1: undefined
     *   2: null
     *   3: true
     *   4: false
     *   5: array start (followed by a items until EOD)
     *   6: object start (followed by key+value pairs until EOD)
     *   7: map start (followed by key+value pairs until EOD)
     *   8: set start (followed by items until EOD)
     *   9: EOD
     *   10: identifier (6 byte positive int follows, represented as a base64 string of length 8)
     *   11: null-terminated string
     * 5: short string (length in lower bits, 0-31)
     * 6: string (byte count of length in lower bits)
     * 7: blob (byte count of length in lower bits)
     */
    write(data: any): DataPack {
        // Pessimistic capacity allocation - covers most cases
        this.ensureCapacity(33); // 1 byte header + up to 32 bytes for large integers/length encoding

        if (typeof data === 'number') {
            if (Number.isInteger(data) && data <= Number.MAX_SAFE_INTEGER && data >= Number.MIN_SAFE_INTEGER) {
                if (data >= 0) {
                    if (data < 32) { // Type 1: small positive integer 0...31
                        this.buffer[this.writePos++] = (1 << 5) | data;
                    } else if (data < 64) { // Type 2: small positive integer 32...63
                        this.buffer[this.writePos++] = (2 << 5) | (data-32);
                    } else { // Type 3: positive integer (byte count in lower bits)
                        this.writeMultiByteNumber(data-64, 3);
                    }
                } else {
                    // Type 0: negative integer (byte count as bitwise NOT in lower bits)
                    this.writeMultiByteNumber(-data, 0, true, true);
                }
            } else {
                // Type 4, subtype 0: float64
                this.buffer[this.writePos++] = (4 << 5) | 0;
                this.dataView ||= new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
                this.dataView.setFloat64(this.writePos, data);
                this.writePos += 8;
            }
        } else if (data === undefined) {
            this.buffer[this.writePos++] = (4 << 5) | 1;
        } else if (data === null) {
            this.buffer[this.writePos++] = (4 << 5) | 2;
        } else if (data === true) {
            this.buffer[this.writePos++] = (4 << 5) | 3;
        } else if (data === false) {
            this.buffer[this.writePos++] = (4 << 5) | 4;
        } else if (typeof data === 'string') {
            const encoded = encoder.encode(data);
            if (encoded.length < 32) {
                // Type 5: short string (length in lower bits, 0-31)
                this.buffer[this.writePos++] = (5 << 5) | encoded.length;
            } else {
                // Type 6: string (byte count of length in lower bits)
                this.writeMultiByteNumber(encoded.length, 6);
            }
            this.ensureCapacity(encoded.length);
            this.buffer.set(encoded, this.writePos);
            this.writePos += encoded.length;
        } else if (data instanceof Uint8Array) {
            // Type 7: blob (byte count of length in lower bits)
            this.writeMultiByteNumber(data.length, 7);
            this.ensureCapacity(data.length);
            this.buffer.set(data, this.writePos);
            this.writePos += data.length;
        } else if (Array.isArray(data)) {
            // Type 4, subtype 5: array start
            this.buffer[this.writePos++] = (4 << 5) | 5;
            for (const item of data) {
                this.write(item);
            }
            this.buffer[this.writePos++] = (4 << 5) | 9; // EOD
        } else if (data instanceof Map) {
            // Type 4, subtype 7: map start
            this.buffer[this.writePos++] = (4 << 5) | 7;
            for (const [key, value] of data) {
                this.write(key);
                this.write(value);
            }
            this.buffer[this.writePos++] = (4 << 5) | 9; // EOD
        } else if (data instanceof Set) {
            // Type 4, subtype 8: set start
            this.buffer[this.writePos++] = (4 << 5) | 8;
            for (const item of data) {
                this.write(item);
            }
            this.buffer[this.writePos++] = (4 << 5) | 9; // EOD
        } else if (data instanceof Date) {
            // Type 4, subtype 12: Date/Time
            this.buffer[this.writePos++] = (4 << 5) | 12;
            // Write a varint -- whole seconds should be plenty of resolution
            this.write(Math.floor(data.getTime()/1000));
        } else if (typeof data === 'object' && data.constructor === Object) {
            // Type 4, subtype 6: object start
            this.buffer[this.writePos++] = (4 << 5) | 6;
            for (const [key, value] of Object.entries(data)) {
                this.write(key);
                this.write(value);
            }
            this.buffer[this.writePos++] = (4 << 5) | 9; // EOD
        } else {
            throw new Error(`Unsupported data type: ${typeof data}`);
        }
        return this;
    }

    read(): any {
        if (this.readPos > this.writePos) {
            throw new Error('Not enough data');
        }

        const header = this.buffer[this.readPos++];
        const type = (header >> 5) & 0x07;
        const subtype = header & 0x1F;

        switch (type) {
            case 0: {
                // Negative integer (byte count as bitwise NOT in lower bits)
                const byteCount = (~subtype) & 0x1F;
                return -this.readMultiByteNumber(byteCount, true);
            }

            case 1: {
                // Small positive integer 0...31
                return subtype;
            }

            case 2: {
                // Small positive integer 32..63
                return subtype + 32;
            }

            case 3: {
                // Positive integer (byte count in lower bits)
                return this.readMultiByteNumber(subtype) + 64;
            }

            case 4: {
                // Special values and container starts
                switch (subtype) {
                    case 0: {
                        // float64
                        if (this.readPos + 8 > this.writePos) this.notEnoughData('float64');
                        this.dataView ||= new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
                        const result = this.dataView.getFloat64(this.readPos);
                        this.readPos += 8;
                        return result;
                    }
                    case 1: return undefined;
                    case 2: return null;
                    case 3: return true;
                    case 4: return false;
                    case 5: {
                        // Array start
                        const result = [];
                        while (true) {
                            const nextValue = this.read();
                            if (nextValue === EOD) break;
                            result.push(nextValue);
                        }
                        return result;
                    }
                    case 6: {
                        // Object start
                        const result: any = {};
                        while (true) {
                            const key = this.read();
                            if (key === EOD) break;
                            const value = this.read();
                            result[key] = value;
                        }
                        return result;
                    }
                    case 7: {
                        // Map start
                        const result = new Map();
                        while (true) {
                            const key = this.read();
                            if (key === EOD) break;
                            const value = this.read();
                            result.set(key, value);
                        }
                        return result;
                    }
                    case 8: {
                        // Set start
                        const result = new Set();
                        while (true) {
                            const value = this.read();
                            if (value === EOD) break;
                            result.add(value);
                        }
                        return result;
                    }
                    case 9: return EOD;
                    case 10: {
                        // Identifier (6 byte positive int follows, represented as a base64 string of length 8)
                        --this.readPos;
                        return this.readIdentifier();
                    }
                    case 11: {
                        // Null-terminated string
                        const start = this.readPos;
                        let end = start;
                        while (true) {
                            if (end >= this.writePos) this.notEnoughData('null-terminated string');
                            if (this.buffer[end] === 0) break;
                            end++;
                        }
                        this.readPos = end + 1; // Skip the null terminator
                        return decoder.decode(this.buffer.subarray(start, end));
                    }
                    case 12: {
                        // Date/Time (varint with whole seconds since epoch follows)
                        const seconds = this.readPositiveInt();
                        return new Date(seconds * 1000);
                    }
                    default: throw new Error(`Unknown type 4 subtype: ${subtype}`);
                }
            }

            case 5: {
                // Short string (length in lower bits, 0-31)
                const length = subtype;
                if (this.readPos + length > this.writePos) this.notEnoughData('short string');
                const bytes = this.buffer.subarray(this.readPos, this.readPos + length);
                this.readPos += length;
                return decoder.decode(bytes);
            }

            case 6: {
                // String (byte count of length in lower bits)
                const length = this.readMultiByteNumber(subtype);
                if (this.readPos + length > this.writePos) this.notEnoughData('string');
                const bytes = this.buffer.subarray(this.readPos, this.readPos + length);
                this.readPos += length;
                return decoder.decode(bytes);
            }

            case 7: {
                // Blob (byte count of length in lower bits)
                const length = this.readMultiByteNumber(subtype);
                if (this.readPos + length > this.writePos) this.notEnoughData('blob');
                // This makes an actual copy of the underlying buffer data
                const result = this.buffer.slice(this.readPos, this.readPos + length);
                this.readPos += length;
                return new Uint8Array(result); // Return a copy
            }

            default: throw new Error(`Unknown type: ${type}`);
        }
    }

    /**
     * Ensure the buffer has capacity for additional bytes.
     * @param bytesNeeded - Number of additional bytes needed.
     */
    private ensureCapacity(bytesNeeded: number): void {
        const needed = this.writePos + bytesNeeded;
        if (needed <= this.buffer.length) return;
        
        // Grow by 1.5x or the needed amount, whichever is larger
        const newCapacity = Math.max(needed, Math.floor(this.buffer.length * 1.5));
        const newBuffer = new Uint8Array(newCapacity);
        newBuffer.set(this.buffer.subarray(0, this.writePos));
        this.buffer = newBuffer;
        delete this.dataView;
    }

    readNumber(): number {
        const result = this.read();
        if (typeof result !== 'number') {
            throw new Error('Expected number but got ' + typeof result);
        }
        return result;
    }

    readDate(): Date {
        const result = this.read();
        if (!(result instanceof Date)) {
            throw new Error('Expected Date but got ' + typeof result);
        }
        return result;
    }

    readPositiveInt(limit?: number): number {
        const result = this.read();
        if (typeof result !== 'number' || !Number.isInteger(result) || result < 0 || (limit !== undefined && result >= limit)) {
            throw new Error(`Expected positive integer < ${limit} but got ${result}`);
        }
        return result;
    }

    readBoolean(): boolean {
        const result = this.read();
        if (typeof result !== 'boolean') {
            throw new Error('Expected boolean but got ' + typeof result);
        }
        return result;
    }

    readUint8Array(): Uint8Array {
        const result = this.read();
        if (!(result instanceof Uint8Array)) {
            throw new Error('Expected Uint8Array but got ' + typeof result);
        }
        return result;
    }
    
    readString(): string {
        const result = this.read();
        if (typeof result !== 'string') {
            throw new Error('Expected string but got ' + typeof result);
        }
        return result;
    }

    writeIdentifier(id: string): DataPack {
        if (id.length !== 8) {
            throw new Error(`Identifier must be exactly 8 characters, got ${id.length}`);
        }
        
        // Convert base64 string to 48-bit number
        let value, num = 0;
        for (let i = 0; i < 8; i++) {
            const char = id.charCodeAt(i);
            if (char > 127 || (value = BASE64_LOOKUP[char]) === 255) {
                throw new Error(`Invalid base64 character: ${id[i]}`);
            }
            num = num * 64 + value;
        }
        
        // Write type 4, subtype 10 header
        this.ensureCapacity(7); // 1 byte header + 6 bytes for the number
        this.buffer[this.writePos++] = (4 << 5) | 10;
        
        // Write the 6-byte number in big-endian format
        for (let i = 5; i >= 0; i--) {
            this.buffer[this.writePos++] = Math.floor(num / Math.pow(256, i)) & 0xFF;
        }
        
        return this;
    }

    readIdentifier(): string {
        // Read the 6-byte number in big-endian format
        if (this.readPos + 7 > this.writePos) this.notEnoughData('identifier');

        const header = this.buffer[this.readPos++];
        if (header !== ((4 << 5) | 10)) {
            throw new Error('Invalid identifier header');
        }
        
        let num = 0;
        for (let i = 0; i < 6; i++) {
            num = (num * 256) + this.buffer[this.readPos++];
        }
        
        // Convert 48-bit number back to 8-character base64 string
        let id = '';
        for (let i = 0; i < 8; i++) {
            id = BASE64_CHARS[num % 64] + id;
            num = Math.floor(num / 64);
        }
        
        return id;
    }

    /**
     * Like writeString but writes without a length prefix and with a null terminator, for ordered storage.
     * Can be read with {@link read} or {@link readString} just like any other string.
     * @param str - The string to write. May not contain null characters.
     */
    writeOrderedString(str: string): DataPack {
        const utf8Bytes = new TextEncoder().encode(str);
        if (utf8Bytes.includes(0)) {
            throw new Error('String contains null character');
        }
        this.ensureCapacity(utf8Bytes.length + 2);
        this.buffer[this.writePos++] = (4 << 5) | 11; // Null-terminated string
        this.buffer.set(utf8Bytes, this.writePos);
        this.writePos += utf8Bytes.length;
        this.buffer[this.writePos++] = 0; // Null terminator
        return this;
    }

    toUint8Array(copyBuffer: boolean = true, startPos: number = 0, endPos: number = this.writePos): Uint8Array {
        return copyBuffer ? this.buffer.slice(startPos, endPos) : this.buffer.subarray(startPos, endPos);
    }

    clone(copyBuffer: boolean, readPos: number = 0, writePos: number = this.writePos): DataPack {
        if (copyBuffer) {
            return new DataPack(this.buffer.slice(readPos, writePos));
        } else {
            const pack = new DataPack(this.buffer);
            pack.readPos = readPos;
            pack.writePos = writePos;
            return pack;
        }
    }

    /**
     * Write a collection (array, set, object, or map) using a callback to add items/fields.
     * @param type 'array' | 'set' | 'object' | 'map'
     * @param bodyFunc Callback function to add items/fields. It accepts a function to add values or key-value pairs (depending on the collection type).
     * @returns The DataPack instance for chaining.
     * @example
     * // Writing an array
     * pack.writeCollection('array', add => {
     *     add(1);
     *     add(2);
     *     add(3);
     * });
     * 
     * // Writing an object
     * pack.writeCollection('object', (add) => {
     *     add('key1', 'value1');
     *     add('key2', 42);
     * });
     */
    writeCollection(type: 'array' | 'set', bodyFunc: (addField: (value: any) => void) => void): DataPack;
    writeCollection(type: 'object', bodyFunc: (addField: (field: number|string|symbol, value: any) => void) => void): DataPack;
    writeCollection(type: 'map', bodyFunc: (addField: (field: any, value: any) => void) => void): DataPack;

    writeCollection(type: string, bodyFunc: (addField: (a: any, b?: any) => void) => void): DataPack {
        let subType = {'array': 5, 'object': 6, 'map': 7, 'set': 8}[type];
        if (!subType) throw new Error(`Invalid collection type: ${type}`);
        this.buffer[this.writePos++] = (4 << 5) | subType; // Collection start

        bodyFunc((type === 'array' || type === 'set') ? (value: any) => {
            this.write(value);
        } : (name, value) => {
            this.write(name);
            this.write(value);
        });
        this.buffer[this.writePos++] = (4 << 5) | 9; // EOD
        return this;
    }

    /** 
     * Increment the last byte of the buffer. If it was already 255 set it to 0 and
     * increment the previous byte, and so on. If all bytes were 255, return undefined.
     * This is useful for creating an exclusive end key for range scans.
     * This may result in a DataPack instance that cannot be parsed (or represented by
     * {@link toString}).
     */
    increment(): DataPack | undefined {
        for(let byte=this.writePos-1; byte >= 0; byte--) {
            if (this.buffer[byte] === 255) {
                // Byte is all 1s, set to 0 and continue
                this.buffer[byte] = 0;
            } else {
                this.buffer[byte]++;
                return this;
            }
        }
        return undefined; // All bytes were 255 (and are now 0)
    }

    toString(extended: boolean | undefined = undefined, startPos: number = 0, endPos: number = this.writePos): string {
        if (extended === undefined) extended = useExtendedLogging;
        let oldReadPos = this.readPos;
        this.readPos = startPos;
        
        let lastPos = 0;
        let vals = '';
        let hexs = '';
        const orgTermCount = toStringTermCount;
        const resetColor = orgTermCount > 0 ? COLORS[(orgTermCount-1) % COLORS.length] : RESET_COLOR;

        try {
            while(this.readPos < endPos) {
                const color = COLORS[toStringTermCount++ % COLORS.length];
                vals += color + toText(this.read()) + ' ';
                if (extended) {
                    hexs += color;
                    while(lastPos < this.readPos) {
                        hexs += this.buffer[lastPos].toString(16).padStart(2, '0') + ' ';
                        lastPos++;
                    }
                }
            }
        } catch(e) {
            if (!extended) {
                this.readPos = oldReadPos;
                toStringTermCount = orgTermCount;
                return this.toString(true, startPos, endPos);
            }
            vals += ERROR_COLOR + "ERROR ";
            hexs += ERROR_COLOR;
            while(lastPos < this.writePos) {
                hexs += this.buffer[lastPos].toString(16).padStart(2, '0') + ' ';
                lastPos++;
            }
        }
        this.readPos = oldReadPos;

        if (!orgTermCount) toStringTermCount = 0;

        if (extended) {
            return "DataPack{" + hexs + resetColor + "→ " + vals.trimEnd() + resetColor + "}";
        } else {
            return "DataPack{" + vals.trimEnd() + resetColor + "}"; 
        }
    }

    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return this.toString();
    }

    readAvailable(): boolean {
        return this.readPos < this.writePos;
    }

    static generateIdentifier(): string {
        // Combine a timestamp with randomness, to create locality of reference as well as a high chance of uniqueness.
        // Bits 9...48 are the date in ms (wrapping about every 34 years), providing some `locality of reference
        // Bit 0...14 are random bits (partly overlapping with the date, adding up to 62ms of jitter)
        let num = Math.floor(+new Date() * (1<<8) + Math.random() * (1<<14));
        
        let id = '';
        for(let i = 0; i < 8; i++) {
            id = BASE64_CHARS[num & 0x3f] + id;
            num = Math.floor(num / 64);
        }
        return id;
    }
}

function toText(v: any): string {
    if (v===undefined) return 'undefined';
    if (typeof v === 'object' && v !== null) {
        if (v instanceof Uint8Array) return new DataPack(v).toString();
        if (v instanceof Array) return '[' + v.map(vv => toText(vv)).join(', ') + ']';
        if (v instanceof Map) return 'Map{' + Array.from(v.entries()).map(([k, val]) => `${toText(k)}=>${toText(val)}`).join(', ') + '}';
        if (v instanceof Set) return 'Set{' + Array.from(v.values()).map(vv => toText(vv)).join(', ') + '}';
        if (typeof v === 'object' && v !== null) return '{' + Object.entries(v).map(([k, val]) => `${k}:${toText(val)}`).join(', ') + '}';
    }
    return JSON.stringify(v);
}
