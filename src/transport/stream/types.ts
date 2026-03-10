export type WaStreamControlNodeResult =
    | { readonly kind: 'xmlstreamend' }
    | { readonly kind: 'stream_error_code'; readonly code: number }
    | { readonly kind: 'stream_error_replaced' }
    | { readonly kind: 'stream_error_device_removed' }
    | { readonly kind: 'stream_error_ack'; readonly id?: string }
    | { readonly kind: 'stream_error_xml_not_well_formed' }
    | { readonly kind: 'stream_error_other' }
