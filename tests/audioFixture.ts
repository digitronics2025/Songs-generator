export function tone() {
  const sampleRate = 22_050;
  const frames = sampleRate * 30;
  const bytes = new Uint8Array(44 + frames * 2);
  const pcm = Buffer.from(bytes.buffer);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(sampleRate, 24);
  pcm.writeUInt32LE(sampleRate * 2, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), 44 + i * 2);
  }
  return pcm;
}
