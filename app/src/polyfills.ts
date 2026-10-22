import { Buffer } from 'buffer';

globalThis.Buffer = Buffer;
if (typeof window !== 'undefined') {
  window.Buffer = Buffer;
}

export { Buffer };
export default {};
