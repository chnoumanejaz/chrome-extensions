/**
 * Fixed-capacity buffer that keeps the newest N items.
 * Universal file (see shared/protocol.js).
 */
(() => {
  if (globalThis.BugDetectorRingBuffer) return;

  class RingBuffer {
    #items;
    #start = 0;
    #size = 0;

    constructor(capacity) {
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new RangeError("RingBuffer capacity must be a positive integer");
      }
      this.capacity = capacity;
      this.#items = new Array(capacity);
    }

    get size() {
      return this.#size;
    }

    push(item) {
      const index = (this.#start + this.#size) % this.capacity;
      this.#items[index] = item;
      if (this.#size < this.capacity) {
        this.#size += 1;
      } else {
        this.#start = (this.#start + 1) % this.capacity;
      }
      return item;
    }

    /** Newest item, or undefined when empty. */
    last() {
      if (!this.#size) return undefined;
      return this.#items[(this.#start + this.#size - 1) % this.capacity];
    }

    /** Items oldest → newest. */
    toArray() {
      const out = new Array(this.#size);
      for (let i = 0; i < this.#size; i += 1) {
        out[i] = this.#items[(this.#start + i) % this.capacity];
      }
      return out;
    }

    clear() {
      this.#items = new Array(this.capacity);
      this.#start = 0;
      this.#size = 0;
    }
  }

  globalThis.BugDetectorRingBuffer = RingBuffer;
})();
