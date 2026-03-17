const base = require('@vinikjkkj/eslint-config')

module.exports = [
    {
        ignores: [
            'proto/index.js',
            'proto/index.d.ts',
            'proto/*.tmp.*',
            'proto/WAProto.codegen.tmp.proto',
            'proto/WAProto.types.codegen.tmp.js'
        ]
    },
    ...base,
    {
        files: ['examples/**/*.{ts,js}', 'scripts/**/*.{ts,js}', '/src/**/*.{ts,js}'],
        languageOptions: {
            parserOptions: {
                project: false
            }
        }
    }
]
