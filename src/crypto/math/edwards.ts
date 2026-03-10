import { BASE_POINT, IDENTITY_POINT, TWO_D } from '@crypto/math/constants'
import { bigIntToBytesLE } from '@crypto/math/le'
import { mod, modGroup, modInv } from '@crypto/math/mod'
import type { ExtendedPoint } from '@crypto/math/types'

export function addPoint(a: ExtendedPoint, b: ExtendedPoint): ExtendedPoint {
    const y1MinusX1 = mod(a.y - a.x)
    const y2MinusX2 = mod(b.y - b.x)
    const y1PlusX1 = mod(a.y + a.x)
    const y2PlusX2 = mod(b.y + b.x)
    const aTerm = mod(y1MinusX1 * y2MinusX2)
    const bTerm = mod(y1PlusX1 * y2PlusX2)
    const cTerm = mod(TWO_D * a.t * b.t)
    const dTerm = mod(2n * a.z * b.z)
    const eTerm = mod(bTerm - aTerm)
    const fTerm = mod(dTerm - cTerm)
    const gTerm = mod(dTerm + cTerm)
    const hTerm = mod(bTerm + aTerm)
    return {
        x: mod(eTerm * fTerm),
        y: mod(gTerm * hTerm),
        z: mod(fTerm * gTerm),
        t: mod(eTerm * hTerm)
    }
}

export function doublePoint(point: ExtendedPoint): ExtendedPoint {
    const aTerm = mod(point.x * point.x)
    const bTerm = mod(point.y * point.y)
    const cTerm = mod(2n * point.z * point.z)
    const dTerm = mod(-aTerm)
    const eTerm = mod(mod((point.x + point.y) * (point.x + point.y)) - aTerm - bTerm)
    const gTerm = mod(dTerm + bTerm)
    const fTerm = mod(gTerm - cTerm)
    const hTerm = mod(dTerm - bTerm)
    return {
        x: mod(eTerm * fTerm),
        y: mod(gTerm * hTerm),
        z: mod(fTerm * gTerm),
        t: mod(eTerm * hTerm)
    }
}

export function scalarMultBase(scalar: bigint): ExtendedPoint {
    let k = modGroup(scalar)
    let result = IDENTITY_POINT
    let addend = BASE_POINT
    while (k > 0n) {
        if ((k & 1n) === 1n) {
            result = addPoint(result, addend)
        }
        addend = doublePoint(addend)
        k >>= 1n
    }
    return result
}

export function encodeExtendedPoint(point: ExtendedPoint): Uint8Array {
    const zInv = modInv(point.z)
    const x = mod(point.x * zInv)
    const y = mod(point.y * zInv)
    const encoded = bigIntToBytesLE(y, 32)
    encoded[31] = (encoded[31] & 0x7f) | Number((x & 1n) << 7n)
    return encoded
}
