// Off-main-thread FLAC encoding. Strict request/response: every incoming
// message gets exactly one reply, which the driver uses for backpressure.
import { FlacEncoder } from './flac.js';

let encoder = null;

onmessage = ({ data }) => {
  if (data.type === 'start') {
    encoder = new FlacEncoder({ sampleRate: data.sampleRate, totalSamples: data.totalSamples });
    const bytes = encoder.header();
    postMessage({ type: 'part', bytes }, [bytes.buffer]);
  } else if (data.type === 'chunk') {
    const bytes = encoder.feed(new Int16Array(data.buffer));
    postMessage({ type: 'part', bytes }, [bytes.buffer]);
  } else if (data.type === 'finish') {
    const bytes = encoder.finish();
    postMessage({ type: 'done', bytes }, [bytes.buffer]);
  }
};
