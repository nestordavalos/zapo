import { concatBytes, toBytesView } from '../../util/bytes'

const EMPTY_BYTES = new Uint8Array(0)

function frameLength(header: Uint8Array): number {
    return (header[0] << 16) | (header[1] << 8) | header[2]
}

export class WaFrameCodec {
    private readonly introFrame: Uint8Array | null
    private introSent: boolean
    private buffered: Uint8Array

    public constructor(introFrame?: Uint8Array) {
        this.introFrame = introFrame && introFrame.length > 0 ? toBytesView(introFrame) : null
        this.introSent = false
        this.buffered = EMPTY_BYTES
    }

    public encodeFrame(frame: Uint8Array): Uint8Array {
        if (frame.length >= 1 << 24) {
            throw new Error(`frame is too large: ${frame.length} bytes`)
        }
        if (!this.introSent && this.introFrame) {
            this.introSent = true
            const out = new Uint8Array(this.introFrame.length + 3 + frame.length)
            out.set(this.introFrame, 0)
            const headerOffset = this.introFrame.length
            out[headerOffset] = (frame.length >> 16) & 0xff
            out[headerOffset + 1] = (frame.length >> 8) & 0xff
            out[headerOffset + 2] = frame.length & 0xff
            out.set(frame, headerOffset + 3)
            return out
        }

        this.introSent = true
        const out = new Uint8Array(3 + frame.length)
        out[0] = (frame.length >> 16) & 0xff
        out[1] = (frame.length >> 8) & 0xff
        out[2] = frame.length & 0xff
        out.set(frame, 3)
        return out
    }

    public pushWireChunk(chunk: Uint8Array): readonly Uint8Array[] {
        if (chunk.length === 0) {
            return []
        }
        this.buffered =
            this.buffered.length === 0 ? toBytesView(chunk) : concatBytes([this.buffered, chunk])

        const frames: Uint8Array[] = []
        let offset = 0
        while (this.buffered.length - offset >= 3) {
            const header = this.buffered.subarray(offset, offset + 3)
            const length = frameLength(header)
            if (this.buffered.length - offset - 3 < length) {
                break
            }
            const start = offset + 3
            const end = start + length
            frames.push(this.buffered.subarray(start, end))
            offset = end
        }

        if (offset === 0) {
            return frames
        }
        this.buffered =
            offset >= this.buffered.length ? EMPTY_BYTES : this.buffered.subarray(offset)
        return frames
    }
}
