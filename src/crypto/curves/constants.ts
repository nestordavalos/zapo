import { toBytesView } from '../../util/bytes'

export const X25519_PKCS8_PREFIX = toBytesView(
    Buffer.from('302e020100300506032b656e04220420', 'hex')
)
export const ED25519_PKCS8_PREFIX = toBytesView(
    Buffer.from('302e020100300506032b657004220420', 'hex')
)
