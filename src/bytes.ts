const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const BIT_COUNTS = [19, 35, 53]; // Bit counts for large integers

export class Bytes {
    public buffer: Uint8Array;
    public readByte: number = 0;
    public readBit: number = 8;
    public writeByte: number = 0;
    public writeBit: number = 8;
    
    constructor(data: Uint8Array | number | undefined = undefined) {
        if (data instanceof Uint8Array) {
            this.buffer = data;
            this.writeByte = data.length;
        } else {
            this.buffer = new Uint8Array(data ?? 64);
        }
    }

    reset() {
        this.readByte = 0;
        this.readBit = 8;
    }

    byteCount(): number {
        return this.writeByte + (this.writeBit < 8 ? 1 : 0);
    }

    bitCount(): number {
        return (this.writeByte * 8) + (8 - this.writeBit);
    }

    /** Safe up til 30 bits */
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

    /** Safe up til 30 bits */
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

    writeUIntN(value: number, maxValue: number): Bytes {
        if (!Number.isInteger(value) || value < 0 || value > maxValue) {
            throw new Error(`Value out of range: ${value} (max: ${maxValue})`);
        }
        
        const bitsNeeded = Math.ceil(Math.log2(maxValue + 1));
        this.writeBits(value, bitsNeeded);
        return this;
    }

    readUIntN(maxValue: number): number {
        if (maxValue < 0) {
            throw new Error(`Invalid max value: ${maxValue}`);
        }
        
        const bitsNeeded = Math.ceil(Math.log2(maxValue + 1));
        return this.readBits(bitsNeeded);
    }

    padReadBits() {
        // If we have any bits left in the current byte, pad them to 8
        if (this.readBit < 8) {
            this.readByte++;
            this.readBit = 8;
        }
    }
    
    padWriteBits() {
        // If we have any bits left in the current byte, pad them to 8
        if (this.writeBit < 8) {
            this.writeByte++;
            this.writeBit = 8;
        }
    }

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

    getBuffer(): Uint8Array {
        return this.buffer.subarray(0, this.byteCount());
    }

    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return Array.from(this.getBuffer())
            .map(b => b.toString(16).padStart(2, '0'))
            .join(' ') + ` (${this.byteCount()} bytes)`;
    }

    copy() {
        return new Bytes(this.getBuffer());
    }
}
