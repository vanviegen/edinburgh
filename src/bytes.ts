import { buffer } from "node:stream/consumers";

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const BIT_COUNTS = [0, 3, 6, 12, 18, 24, 36, 53]; // Cannot be larger than 27 bits due to 32-bit bitwise logic in readNumber/writeNumber
const INT_LIMIT = Math.pow(2, BIT_COUNTS[BIT_COUNTS.length - 1]); // Integers outside this range are stored as float64

/**
 * A byte buffer for efficient reading and writing of primitive values and bit sequences.
 * 
 * The Bytes class provides methods for serializing and deserializing various data types
 * including numbers, strings, bit sequences, and other primitive values to/from byte buffers.
 * It supports both reading and writing operations with automatic buffer management.
 */
export class Bytes {
    public _buffer: Uint8Array;
    public _dataView?: DataView;
    public readPos: number = 0;
    public writePos: number = 0;
    
    static BASE64_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    static BASE64_LOOKUP = (() => {
        const arr = new Uint8Array(128); // all ASCII
        for (let i = 0; i < this.BASE64_CHARS.length; ++i) arr[this.BASE64_CHARS.charCodeAt(i)] = i;
        return arr;
    })();

    /**
     * Create a new Bytes instance.
     * @param data - Optional initial data as Uint8Array or buffer size as number.
     */
    constructor(data: Uint8Array | number | undefined = undefined) {
        if (data instanceof Uint8Array) {
            this._buffer = data;
            this.writePos = data.length * 8;
        } else {
            this._buffer = new Uint8Array(data ?? 64);
        }
    }

    /**
     * Reset read position to the beginning of the buffer.
     * @returns This Bytes instance for chaining.
     */
    reset() {
        this.readPos = 0;
        return this;
    }

    /**
     * Get the number of bytes written to the buffer.
     * @returns The byte count.
     */
    byteCount(): number {
        return (this.writePos + 7) >> 3;
    }

    /**
     * Get the number of bits written to the buffer.
     * @returns The bit count.
     */
    bitCount(): number {
        return this.writePos;
    }

    /**
     * @returns true if more bites can be read.
     */
    readAvailable(): number {
        return Math.max(0, this.writePos - this.readPos);
    }

    /**
     * Read a specific number of bits from the buffer (safe up to 30 bits).
     * @param bits - Number of bits to read (0-30).
     * @param flip - Whether to flip the bit order.
     * @returns The read value as a number.
     */
    readBits(bits: number, flip: boolean=false): number {
        if (bits < 0 || bits > 30) {
            throw new Error('Invalid bit count');
        }
        
        // Single bounds check upfront
        if (bits > this.writePos - this.readPos) {
            throw new Error('Not enough bits available');
        }
        
        const buffer = this._buffer;
        let result = 0;
        let pos = this.readPos;
        let remaining = bits;

        // Handle partial first byte
        if (pos & 7) {
            const available = 8 - (pos & 7);
            const take = Math.min(remaining, available);
            result = (buffer[pos >> 3] >> (available - take)) & ((1 << take) - 1);
            pos += take;
            remaining -= take;
        }

        // Read full bytes
        while (remaining >= 8) {
            result = (result << 8) | buffer[pos >> 3];
            pos += 8;
            remaining -= 8;
        }

        // Handle partial last byte
        if (remaining) {
            result = (result << remaining) | ((buffer[pos >> 3] >> (8 - remaining)) & ((1 << remaining) - 1));
            pos += remaining;
        }

        this.readPos = pos;

        return flip ? ((1 << bits) - 1) ^ result : result;
    }

    /**
     * Write a specific number of bits to the buffer (safe up to 30 bits).
     * @param value - The value to write.
     * @param bits - Number of bits to write (0-30).
     * @param flip - Whether to flip the bit order.
     * @returns This Bytes instance for chaining.
     */
    writeBits(value: number, bits: number, flip: boolean=false): Bytes {
        if (bits < 0 || bits > 30) {
            throw new Error('Invalid bit count');
        }
        value = flip ? ((1 << bits) - 1) ^ value : value;
                
        this.ensureCapacity(bits);
        
        const buffer = this._buffer;
        let pos = this.writePos;
        let remaining = bits;

        if (pos & 7) { // First partial byte
            const available = 8 - (pos & 7);
            const take = Math.min(remaining, available);
            buffer[pos >> 3] |= (((value >> (remaining - take)) & ((1 << take) - 1)) << (available - take));
            pos += take;
            remaining -= take;
        }

        while (remaining >= 8) { // Full bytes
            remaining -= 8;
            buffer[pos >> 3] = (value >> remaining) & 0xFF;
            pos += 8;
        }

        if (remaining) { // Last partial byte
            buffer[pos >> 3] |= ((value & ((1 << remaining) - 1)) << (8 - remaining));
            pos += remaining;
        }

        this.writePos = pos;
        return this;
    }

    /**
     * Write an unsigned integer using only the minimum required bits.
     * @param value - The value to write (must be 0 <= value <= maxValue).
     * @param maxValue - The maximum possible value.
     * @returns This Bytes instance for chaining.
     */
    writeUIntN(value: number, maxValue: number): Bytes {
        if (!Number.isInteger(value) || value < 0 || value > maxValue) {
            throw new Error(`Value out of range: ${value} (max: ${maxValue})`);
        }
        
        const bitsNeeded = Math.ceil(Math.log2(maxValue + 1));
        this.writeBits(value, bitsNeeded);
        return this;
    }

    /**
     * Read an unsigned integer that was written with writeUIntN.
     * @param maxValue - The maximum possible value (same as used in writeUIntN).
     * @returns The read value.
     */
    readUIntN(maxValue: number): number {
        if (maxValue < 0) {
            throw new Error(`Invalid max value: ${maxValue}`);
        }
        
        const bitsNeeded = Math.ceil(Math.log2(maxValue + 1));
        return this.readBits(bitsNeeded);
    }

    /**
     * Read a Base64-encoded string of specified character count.
     * @param charCount - Number of characters to read.
     * @returns The decoded string.
     */
    readBase64(charCount: number): string {
        let result = '';
        for(let i = 0; i < charCount; i++) {
            result += Bytes.BASE64_CHARS[this.readBits(6)];
        }
        return result;
    }
    
    /**
     * Write a Base64-encoded string to the buffer.
     * @param value - The Base64 string to write.
     * @returns This Bytes instance for chaining.
     */
    writeBase64(value: string) {
        this.ensureCapacity(value.length * 6);
        for(let i = 0; i < value.length; i++) {
            const v = Bytes.BASE64_LOOKUP[value.charCodeAt(i)];
            if (v == undefined) throw new Error(`Invalid Base64 character: ${value[i]}`);
            this.writeBits(v, 6);
        }
        return this;
    }

    /**
     * Pad read position to byte boundary.
     * 
     * If currently reading in the middle of a byte, advance to the next byte boundary.
     */
    padReadBits() {
        // If we have any bits left in the current byte, pad them to 8
        this.readPos = (this.readPos + 7) & ~7;
    }
    
    /**
     * Pad write position to byte boundary.
     * 
     * If currently writing in the middle of a byte, advance to the next byte boundary.
     */
    padWriteBits() {
        // If we have any bits left in the current byte, pad them to 8
        this.writePos = (this.writePos + 7) & ~7;
    }

    /**
     * Ensure the buffer has capacity for additional bits.
     * @param bitsNeeded - Number of additional bits needed.
     */
    ensureCapacity(bitsNeeded: number): void {
        const needed = (this.writePos + bitsNeeded + 7) >> 3;
        if (needed <= this._buffer.length) return;
        
        // Grow by 1.5x or the needed amount, whichever is larger
        const newCapacity = Math.max(needed, Math.floor(this._buffer.length * 1.5));
        const newBuffer = new Uint8Array(newCapacity);
        newBuffer.set(this._buffer.subarray(0, this.byteCount()));
        this._buffer = newBuffer;
        delete this._dataView;
    }


    /**
     * Write a number to the buffer using efficient encoding.
     * 
     * Integers are encoded using variable-length encoding based on their magnitude.
     * Large numbers and floating-point numbers use standard IEEE 754 representation.
     * 
     * @param value - The number to write.
     * @returns This Bytes instance for chaining.
     */
    writeNumber(value: number): Bytes {
        /**
         * 3 bits header:
         *   - 0: negative, followed by another 3 bit header:
         *      - 0: an 8 byte float follows 
         *      - 1-7: like below, but flipped (bitwise NOT)
         *   1-7: positive int in 3, 6, 12, 18, 24, 36, 53 bits
         */
        if (Number.isInteger(value) && value > -INT_LIMIT && value < INT_LIMIT) {
            let flip = false;
            if (value < 0) { 
                this.writeBits(0, 3); // negative integer header
                value = -value;
                flip = true;
            }
            let bitCountIndex = 1, bitCount;
            while(true) {
                bitCount = BIT_COUNTS[bitCountIndex];
                if (bitCountIndex === 7 || value < (1 << bitCount)) break;
                bitCountIndex++;
            }
            // Combine header and value in a single writeBits, for efficiency
            if (bitCount <= 30) {
                this.writeBits((bitCountIndex << bitCount) | value, 3 + bitCount, flip); // header + value
            } else {
                const highBitCount = bitCount - 30;
                this.writeBits((bitCountIndex << highBitCount) | (value / 0x40000000), highBitCount+3, flip); // header + most significant bits
                this.writeBits(value & 0x3fffffff, 30, flip); // 30 least significant bits
            }
            return this;
        } else {
            // Float64 - no proper sorting order
            this.writeBits(7, 6); // two subsequent 'negative' (0) headers, the second being inverted ((0 << 3) | (~0 & 7))
            this.padWriteBits(); // Ensure we are byte-aligned
            this.ensureCapacity(8 * 8); // float64 takes 8 bytes
            this._dataView ||= new DataView(this._buffer.buffer, this._buffer.byteOffset, this._buffer.byteLength);
            this._dataView.setFloat64(this.writePos >> 3, value);
            this.writePos += 8 * 8;
        }
        return this;
    }

    /**
     * Read a number from the buffer.
     * 
     * Reads numbers that were written using the writeNumber method,
     * automatically detecting the encoding format.
     * 
     * @returns The read number.
     */
    readNumber(): number {
        let header = this.readBits(3);

        const isNegative = (header === 0);
        if (isNegative) {
            header = this.readBits(3, true); // header 0 (after a header 0) is reserved for future use
            if (header === 0) {
                // Float64
                this.padReadBits();
                this._dataView ||= new DataView(this._buffer.buffer, this._buffer.byteOffset, this._buffer.byteLength);
                const result = this._dataView.getFloat64(this.readPos >> 3);
                this.readPos += 8 * 8;
                return result;
            }
        }

        let bitCount = BIT_COUNTS[header];
        const value = bitCount > 30
            ? this.readBits(bitCount - 30, isNegative) * 0x40000000 + this.readBits(30, isNegative) // too large, read in two parts
            : this.readBits(bitCount, isNegative);
        
        return isNegative ? -value : value;
    }

    /**
     * Write a Uint8Array instance to this buffer, prefixing with its length if specified.
     * @param value - The Uint8Array instance to write.
     * @returns This Bytes instance for chaining.
     */
    writeBlob(value: Uint8Array): Bytes {
        this.writeNumber(value.byteLength);
        return this.writeFixedBlob(value);
    }

    /**
     * Like writeBlob but does not prefix with length, so the reader must know the size.
     */
    writeFixedBlob(value: Uint8Array): Bytes {
        let size = value.byteLength;
        this.padWriteBits();
        this.ensureCapacity(size * 8);
        this._buffer.set(value, this.writePos >> 3);
        this.writePos += size * 8;
        return this;
    }

    /**
     * Read a Uint8Array instance, prefixed with the length, from the buffer. 
     * @returns A new Uint8Array containing the read data.
     */
    readBlob(): Uint8Array {
        return this.readFixedBlob(this.readNumber());
    }

    /**
     * Read a fixed-size Uint8Array instance from the buffer.
     * @param size - The size of the blob to read.
     * @returns A new Uint8Array containing the read data.
     */
    readFixedBlob(size: number): Uint8Array {
        this.padReadBits();
        if (size < 0 || size * 8 > this.writePos - this.readPos) {
            throw new Error('Invalid byte size read');
        }
        const buffer = this._buffer.subarray(this.readPos >> 3, (this.readPos >> 3) + size);
        this.readPos += size * 8;
        return buffer;
    }
    
    /**
     * Write a UTF-8 string to the buffer with null termination.
     * We use null termination instead of length prefixing such that byte representations maintain
     * natural ordering (for index keys).
     * @param value - The string to write.
     * @returns This Bytes instance for chaining.
     */
    writeString(value: string): Bytes {
        // Escape 0 characters and escape characters
        value = value.replace(/[\u0001\u0000]/g, (match: string) => match === '\u0001' ? '\u0001e' : '\u0001z');
        const encoded = encoder.encode(value);
        this.padWriteBits();
        this.ensureCapacity(encoded.length*8 + 8); // +1 byte for null terminator
        let bytePos = this.writePos >> 3;
        this._buffer.set(encoded, bytePos);
        bytePos += encoded.length;
        this._buffer[bytePos++] = 0; // Null terminator
        this.writePos = bytePos * 8;
        return this;
    }

    /**
     * Read a null-terminated UTF-8 string from the buffer.
     * @returns The decoded string.
     */
    readString(): string {
        this.padReadBits();
        const startByte = this.readPos >> 3;;
        const endByte = this._buffer.indexOf(0, startByte);
        
        if (endByte < 0 || endByte * 8 >= this.writePos) {
            throw new Error('String not null-terminated');
        }
        
        const encoded = this._buffer.subarray(startByte, endByte);
        this.readPos = (endByte + 1) * 8; // Skip null terminator
        
        // Decode and unescape
        let value = decoder.decode(encoded);
        value = value.replace(/\u0001[ez]/g, (m: string) => m === '\u0001e' ? '\u0001' : '\u0000');
        
        return value;
    }

    /**
     * Get the current buffer contents as a Uint8Array.
     * @returns A new Uint8Array containing the written data.
     */
    getBuffer(): Uint8Array {
        return this._buffer.subarray(0, this.byteCount());
    }

    getBufferFromReadPos(): Uint8Array {
        if (this.readPos & 7) throw new Error('Read position not byte-aligned');
        return this._buffer.subarray(this.readPos >> 3, this.byteCount());
    }

    /**
     * Create a copy of this Bytes instance, but with the read position at 0.
     * @param shareBuffer - If true, the underlying buffer is shared; otherwise it is copied.
     * @returns A new Bytes instance with the same content.
     */
    copy(shareBuffer: boolean = false) {
        const result = new Bytes(shareBuffer ? this._buffer : this._buffer.slice(0));
        result.writePos = this.writePos;
        return result;
    }

    /** 
     * Increment the last bit of the buffer. If it was already 1 set it to 0 and
     * increment the previous bit, and so on. If all bits were 1, return undefined.
     */
    increment(): Bytes | undefined {
        for(let bit=this.writePos-1; bit >= 0; bit--) {
            const byte = bit >> 3;
            const shift = 1 << (7 - (bit & 7));
            if (this._buffer[byte] & shift) {
                // Bit was 1, set to 0 and continue
                this._buffer[byte] &= ~shift;
            } else {
                // Bit was 0, set to 1 and return
                this._buffer[byte] |= shift;
                return this;
            }
        }
        return undefined; // All bits were 1 (and are now 0)
    }

    toString(): string {
        // Convert this.getBuffer() as utf8 to a string, escaping non-printable characters:
        let result = "[Bytes] " + this.getBuffer().toString();
        if (this.readPos) result += ` read=${this.readPos>>3}:${this.readPos&7}`;
        if (this.writePos) result += ` write=${this.writePos>>3}:${this.writePos&7}`;
        return result;
    }

    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return this.toString();
    }

    static debugEnabled = false;
    static enableDebug() {
        if (this.debugEnabled) return;
        this.debugEnabled = true;

        Uint8Array.prototype.toString = function(this: Uint8Array): string {
            const arr = Array.from(this);
            return (
                "[" + arr.map((b,i) => colorize(i) + b.toString(16).padStart(2, '0')).join(' ') +
                WHITE + ' "' + arr.map((b, i) => colorize(i) + (b < 32 || b > 126 ? '?' : String.fromCharCode(b))).join('') + WHITE + '"]'
            );
        };

        (Uint8Array.prototype as any)[Symbol.for('nodejs.util.inspect.custom')] = Uint8Array.prototype.toString;

        let depth = 0;
        for(const name of Object.getOwnPropertyNames(Bytes.prototype)) {
            const original = (Bytes.prototype as any)[name];
            if (typeof original !== 'function' || name === 'constructor') continue;
            (Bytes.prototype as any)[name] = function(...args: any[]) {
                let startReadPos = this.readPos;
                let startWritePos = this.writePos;
                depth++;
                let insertPos = this.segments?.length || 0;
                let result;
                try {
                    result = original.apply(this, args);
                } finally {
                    --depth;
                }
                const obj: any = { name, args, depth, startPos: this.writePos > startWritePos ? startWritePos : startReadPos, endPos: this.writePos > startWritePos ? this.writePos : this.readPos };
                if (obj.endPos > obj.startPos) {
                    if (result !== this && result !== undefined) obj.result = result;
                    (this.segments ||= []).splice(insertPos, 0, obj);
                }
                return result;
            };
        }
        const originalToString = Bytes.prototype.toString;
        Bytes.prototype.toString = function(this: any) {
            let result = originalToString.call(this);
            if (!this.segments) return result;
            result += " {";
            for(const seg of this.segments) {
                const argStr = seg.args.map(toText).join(',');
                let pattern = '';
                for(let i=seg.startPos; i<seg.endPos; i++) {
                    if (i > seg.startPos && (i&7) === 0) pattern += ' ';
                    pattern += colorize(i>>3) + `${(this._buffer[i>>3]>>>(7-(i&7)))&1}`;
                }
                result += `\n` + `  `.repeat(seg.depth) + `* ${seg.name}(${argStr}) ${pattern}${WHITE}`;
                if ('result' in seg) result += ` => ${toText(seg.result)}`;
            }
            result += "\n}";
            return result;
        };
    }
}

function colorize(i: number) {
    return (i&7) < 4 ? GREEN : YELLOW;
}

function toText(v: any): string {
    if (v instanceof Uint8Array || v instanceof Bytes) return v.toString();
    if (v===undefined) return 'undefined';
    return JSON.stringify(v);
}

const GREEN = '\x1b[32m';
const WHITE = '\x1b[0m';
const YELLOW = '\x1b[33m';


