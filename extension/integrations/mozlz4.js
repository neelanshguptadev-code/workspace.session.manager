/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const MAGIC = [0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00];
const MAX_OUTPUT = 20 * 1024 * 1024;

function readLength(bytes, offset, base) {
    let value = base;
    if (base !== 15)
        return [value, offset];
    while (offset < bytes.length) {
        const extra = bytes[offset];
        offset += 1;
        value += extra;
        if (extra !== 255)
            break;
    }
    return [value, offset];
}

export function decodeMozLz4(input) {
    if (!(input instanceof Uint8Array) || input.length < 12)
        return null;
    for (let index = 0; index < MAGIC.length; index += 1) {
        if (input[index] !== MAGIC[index])
            return null;
    }
    const size = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(8, true);
    if (size < 0 || size > MAX_OUTPUT)
        return null;
    const source = input.subarray(12);
    const output = new Uint8Array(size);
    let read = 0;
    let written = 0;
    while (read < source.length && written < size) {
        const token = source[read];
        read += 1;
        let literalLength;
        [literalLength, read] = readLength(source, read, token >> 4);
        if (literalLength < 0 || read + literalLength > source.length || written + literalLength > size)
            return null;
        output.set(source.subarray(read, read + literalLength), written);
        read += literalLength;
        written += literalLength;
        if (read >= source.length)
            break;
        if (read + 2 > source.length)
            return null;
        const offset = source[read] | (source[read + 1] << 8);
        read += 2;
        if (offset <= 0 || offset > written)
            return null;
        let matchExtra;
        [matchExtra, read] = readLength(source, read, token & 0x0f);
        const matchLength = matchExtra + 4;
        if (written + matchLength > size)
            return null;
        for (let index = 0; index < matchLength; index += 1)
            output[written + index] = output[written - offset + index];
        written += matchLength;
    }
    if (written !== size)
        return null;
    return output;
}
