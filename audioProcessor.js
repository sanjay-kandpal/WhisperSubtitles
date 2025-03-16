class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.sampleRate = 16000;
    this.resampleRatio = 48000 / this.sampleRate; // Assuming standard 48kHz
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0][0];
    if (input) {
      // Resample to 16kHz
      for (let i = 0; i < input.length; i += this.resampleRatio) {
        this.buffer.push(input[Math.floor(i)]);
      }

      // Send buffer to main thread periodically
      if (this.buffer.length > 16000) { // Send every 1 second of audio
        this.port.postMessage({ type: 'buffer', data: this.buffer.slice() });
        this.buffer = [];
      }
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor); 