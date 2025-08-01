const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const BIT_COUNTS = [19, 35, 53]; // Bit counts for large integers

/**
 * A byte buffer for efficient reading and writing of primitive values and bit sequences.
 * 
 * The Bytes class provides methods for serializing and deserializing various data types
 * including numbers, strings, bit sequences, and other primitive values to/from byte buffers.
 * It supports both reading and writing operations with automatic buffer management.
 */
export class Bytes {
    public buffer: Uint8Array;
    public readByte: number = 0;
    public readBit: number = 8;
    public writeByte: number = 0;
    public writeBit: number = 8;
    
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
            this.buffer = data;
            this.writeByte = data.length;
        } else {
            this.buffer = new Uint8Array(data ?? 64);
        }
    }

    /**
     * Reset read position to the beginning of the buffer.
     * @returns This Bytes instance for chaining.
     */
    reset() {
        this.readByte = 0;
        this.readBit = 8;
        return this;
    }

    /**
     * Get the number of bytes written to the buffer.
     * @returns The byte count.
     */
    byteCount(): number {
        return this.writeByte + (this.writeBit < 8 ? 1 : 0);
    }

    /**
     * Get the number of bits written to the buffer.
     * @returns The bit count.
     */
    bitCount(): number {
        return (this.writeByte * 8) + (8 - this.writeBit);
    }

    /**
     * Check if there are more bytes available for reading.
     * @returns true if more bytes can be read.
     */
    readAvailable(): boolean {
        return this.readByte < this.buffer.length;
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
        const totalBitsRemaining = (this.buffer.length - this.readByte) * 8 - (8 - this.readBit);
        if (bits > totalBitsRemaining) {
            throw new Error('Not enough bits available');
        }
        
        let result = 0;
        let bitsLeft = bits;
        
        // Process bits while we need them
        while (bitsLeft > 0) {
            const take = Math.min(bitsLeft, this.readBit);
            bitsLeft -= take;

            if (take===8) { // Fast path for full byte
                result = (result << 8) | this.buffer[this.readByte++];
                // bitPos remains 8, bytePos is incremented
            } else {
                // Extract bits: shift right to get our bits at the bottom, then mask
                const extracted = (this.buffer[this.readByte] >>> (this.readBit - take)) & ((1 << take) - 1);
                
                // The >>> 0 ensures we treat the result as an unsigned integer
                result = ((result << take) >>> 0) | extracted;
                this.readBit -= take;
                
                // Move to next byte if current is exhausted
                if (this.readBit == 0) {
                    this.readByte++;
                    this.readBit = 8;
                }
            }
        }

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
        // console.log(`Writing ${value} with ${bits} bits (flip: ${flip})`);
        if (bits < 0 || bits > 30) {
            throw new Error('Invalid bit count');
        }
        value = flip ? ((1 << bits) - 1) ^ value : value;
                
        this.ensureCapacity(1 + (bits >>> 3));
        
        while (bits > 0) {
            const bitsToWriteNow = Math.min(bits, this.writeBit);
            bits -= bitsToWriteNow;

            if (bitsToWriteNow === 8) { // Fast path for full bytes
                this.buffer[this.writeByte++] = (value >>> bits) & 0xff;
                // bitPos remains 8, bytePos is incremented
            } else {
                const extracted = (value >>> bits) & ((1 << bitsToWriteNow) - 1);
                this.buffer[this.writeByte] |= extracted << (this.writeBit - bitsToWriteNow);

                this.writeBit -= bitsToWriteNow;
                
                // Advance to next byte if current byte is full
                if (this.writeBit === 0) {
                    this.writeByte++;
                    this.writeBit = 8;
                }
            }
        }
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
        this.ensureCapacity(Math.ceil(value.length * 6 / 8));
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
        if (this.readBit < 8) {
            this.readByte++;
            this.readBit = 8;
        }
    }
    
    /**
     * Pad write position to byte boundary.
     * 
     * If currently writing in the middle of a byte, advance to the next byte boundary.
     */
    padWriteBits() {
        // If we have any bits left in the current byte, pad them to 8
        if (this.writeBit < 8) {
            this.writeByte++;
            this.writeBit = 8;
        }
    }

    /**
     * Ensure the buffer has capacity for additional bytes.
     * @param additionalBytes - Number of additional bytes needed.
     */
    ensureCapacity(additionalBytes: number): void {
        const needed = this.writeByte + additionalBytes + 1;
        if (needed <= this.buffer.length) return;
        
        // Grow by 1.5x or the needed amount, whichever is larger
        const newCapacity = Math.max(needed, Math.floor(this.buffer.length * 1.5));
        const newBuffer = new Uint8Array(newCapacity);
        newBuffer.set(this.buffer.subarray(0, this.byteCount()));
        this.buffer = newBuffer;
    }

    /*
    * 5 bit header
    *
    * 0-2: negative integer with 53, 35 or 19 bits
    * 3-14: negative integer with 12..1 bits (the first bit is always 1, and thus left unwritten)
    * 15: literal 0
    * 16-27: positive integer with 1..12 bits (the first bit is always 1, and thus left unwritten)
    * 28-30: positive integer with 19, 35 or 53 bits
    * 31: float64 number (follows after bit padding)
    * 
    * Some examples:
    *    3 bits (incl sign) fit in 6 bits
    *    5 bits (incl sign) fit in 8 bits (1 byte)
    *    6 bits (incl sign) fit in 9 bits
    *   20 bits (incl sign) fit in 24 bits (3 bytes)
    *   36 bits (incl sign) fit in 40 bits (5 bytes)
    *   54 bits (incl sign) fit in 58 bits
    */
    
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
        if (Number.isInteger(value) && value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
            // 33 bit integer (incl sign)
            let num = Math.abs(value);
            let bitCount = Math.ceil(Math.log2(num + 1)); // 0 (for literal 0) til 32 (inclusive)
            const isNegative = value < 0;
            
            if (bitCount < 13) {
                this.writeBits(isNegative ? 15-bitCount : 15+bitCount, 5); // header
                // Don't write the leading 1 bit
                if (bitCount > 1) this.writeBits(0 | num, bitCount-1, isNegative); // value
            } else {
                const sizeOption = bitCount <= 19 ? 0 : (bitCount <= 35 ? 1 : 2);
                bitCount = BIT_COUNTS[sizeOption];

                this.writeBits(isNegative ? 2-sizeOption : 28+sizeOption, 5); // header
                if (bitCount <= 30) {
                    this.writeBits(0 | num, bitCount, isNegative); // data
                } else {
                    this.writeBits(0 | (num / 0x40000000), bitCount-30, isNegative); // most significant bits
                    this.writeBits(num & 0x3fffffff, 30, isNegative); // least significant bits
                }
            }
        } else {
            // Float or large integer
            this.writeBits(31, 5); // header for float
            this.padWriteBits(); // Ensure we are byte-aligned

            this.ensureCapacity(8); // float64 takes 8 bytes
            
            const float64Array = new Float64Array(1);
            float64Array[0] = value;
            const bytes = new Uint8Array(float64Array.buffer);
            this.buffer.set(bytes, this.writeByte);
            this.writeByte += 8;
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
        const header = this.readBits(5);
        
        if (header === 15) {
            // Literal 0
            return 0;
        }
        if (header === 31) {
            // Float64
            this.padReadBits();
            const bytes = new Uint8Array(8);
            for (let i = 0; i < 8; i++) {
                bytes[i] = this.readBits(8);
            }
            return new Float64Array(bytes.buffer)[0];
        }
        
        // Integer handling - determine if positive/negative and get size
        const isNegative = header < 15;
        
        let value: number, bitCount: number;
        
        if (header < 3 || header > 27) {
            // Large integers
            const sizeOption = isNegative ? 2 - header : header - 28;
            bitCount = BIT_COUNTS[sizeOption];
            if (bitCount <= 30) {
                value = this.readBits(bitCount, isNegative);
            } else {
                // Read the two parts of the large integer
                value = this.readBits(bitCount-30, isNegative) * 1073741824 + this.readBits(30, isNegative);
            }

        } else {
            // Small integers: reconstruct bits with implicit leading 1
            bitCount = isNegative ? 15 - header : header - 15;
            
            // Read bits and add implicit leading 1
            value = this.readBits(bitCount - 1, isNegative) | (1 << (bitCount - 1));
        }
        
        return isNegative ? -value : value;
    }
    
    /**
     * Write a UTF-8 string to the buffer with null termination.
     * @param value - The string to write.
     * @returns This Bytes instance for chaining.
     */
    writeString(value: string): Bytes {
        // Escape 0 characters and escape characters
        value = value.replace(/[\u0001\u0000]/g, (match: string) => match === '\u0001' ? '\u0001e' : '\u0001z');
        const encoded = encoder.encode(value);
        this.padWriteBits();
        this.ensureCapacity(encoded.length + 1); // +1 for null terminator
        this.buffer.set(encoded, this.writeByte);
        this.writeByte += encoded.length;
        this.buffer[this.writeByte++] = 0; // Null terminator
        return this;
    }

    /**
     * Write another Bytes instance to this buffer.
     * @param value - The Bytes instance to write.
     * @returns This Bytes instance for chaining.
     */
    writeBytes(value: Bytes): Bytes {
        let size = value.byteCount();
        this.writeNumber(size);
        this.padWriteBits();
        this.ensureCapacity(size);
        this.buffer.set(value.buffer, this.writeByte);
        this.writeByte += size;
        return this;
    }

    /**
     * Read a Bytes instance from the buffer.
     * @returns A new Bytes instance containing the read data.
     */
    readBytes(): Bytes {
        const size = this.readNumber();
        if (size < 0 || size > this.buffer.length - this.readByte) {
            throw new Error('Invalid byte size read');
        }
        const bytes = new Bytes(this.buffer.subarray(this.readByte, this.readByte + size));
        this.readByte += size;
        return bytes;
    }

    /**
     * Read a null-terminated UTF-8 string from the buffer.
     * @returns The decoded string.
     */
    readString(): string {
        this.padReadBits();
        const start = this.readByte;
        const end = this.buffer.indexOf(0, start);
        
        if (end < 0) {
            throw new Error('String not null-terminated');
        }
        
        const encoded = this.buffer.subarray(start, end);
        this.readByte = end + 1; // Skip null terminator
        
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
        return this.buffer.subarray(0, this.byteCount());
    }

    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return Array.from(this.getBuffer())
            .map(b => b.toString(16).padStart(2, '0'))
            .join(' ') + ` (${this.byteCount()} bytes)`;
    }

    /**
     * Create a copy of this Bytes instance.
     * @returns A new Bytes instance with the same content.
     */
    copy() {
        return new Bytes(this.getBuffer());
    }
}
