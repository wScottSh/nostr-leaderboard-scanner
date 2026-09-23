/*
 * collector.js -- accumulates scanned frames until one star capture is whole.
 * Pure (no camera, no DOM), so the scan loop's bookkeeping is testable.
 *
 * The CRT cycles a star's N frames; the camera hands us whatever it decodes,
 * in any order, with repeats. If the screen moves on to a different star
 * mid-scan, the frame set becomes inconsistent: we cannot tell which half is
 * stale, so we restart from the newest frame (a single frame is always
 * self-consistent, so the scan always makes progress).
 */
import { parseFrame, reassembleFrames, base32Decode, decodeEvent } from './decode.js';

export class FrameCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.frames = new Map(); // scanned text -> parsed frame
    this.count = 0;
    this.got = new Set(); // indexes seen
  }

  /**
   * add: one scanned string. Returns
   *   { kind: 'ignored' }                   not a cabinet frame, or already seen
   *   { kind: 'progress', got, count, restarted }
   *   { kind: 'complete', event }
   *   { kind: 'error', error }              frames whole but the payload won't decode
   */
  add(text) {
    if (this.frames.has(text)) return { kind: 'ignored' };
    const frame = parseFrame(text);
    if (!frame) return { kind: 'ignored' };

    let restarted = false;
    this.frames.set(text, frame);
    let result;
    try {
      result = reassembleFrames([...this.frames.values()]);
    } catch {
      this.reset();
      this.frames.set(text, frame);
      result = reassembleFrames([frame]);
      restarted = true;
    }
    this.count = frame.count;
    this.got = new Set([...this.frames.values()].map((f) => f.index));

    if (!result.complete) return { kind: 'progress', got: this.got.size, count: this.count, restarted };
    try {
      return { kind: 'complete', event: decodeEvent(base32Decode(result.base32Text)) };
    } catch (error) {
      this.reset();
      return { kind: 'error', error };
    }
  }
}
