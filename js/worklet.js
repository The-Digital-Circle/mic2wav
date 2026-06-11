class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    let frame;
    if (input.length === 1) {
      frame = input[0].slice();
    } else {
      frame = new Float32Array(input[0].length);
      for (const channel of input) {
        for (let i = 0; i < channel.length; i++) frame[i] += channel[i];
      }
      for (let i = 0; i < frame.length; i++) frame[i] /= input.length;
    }
    this.port.postMessage(frame, [frame.buffer]);
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
