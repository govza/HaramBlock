import { type PluginOption } from 'vite';

function strToUtf8(str: string) {
  return str
    .split('')
    .map(ch => (ch.charCodeAt(0) <= 0x7f ? ch : `\\u${`0000${ch.charCodeAt(0).toString(16)}`.slice(-4)}`))
    .join('');
}

export default function toUtf8(): PluginOption {
  return {
    name: 'to-utf8',
    generateBundle(options, bundle) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk && chunk.type === 'chunk' && typeof chunk.code === 'string') {
          const originalCode = chunk.code;
          const modifiedCode = strToUtf8(originalCode);

          chunk.code = modifiedCode;
        }
      }
    },
  };
}
