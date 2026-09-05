// In-memory KV and R2 mocks compatible with the subset of the Workers
// runtime APIs used by this project. Used by integration tests so the full
// request pipeline runs without workerd.

export class MockKV {
  private map = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string, type?: "json" | "text"): Promise<unknown> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    if (type === "json") return JSON.parse(entry.value);
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.map.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list({ prefix, cursor, limit }: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{
    keys: { name: string }[];
    cursor?: string;
  }> {
    const all = Array.from(this.map.keys())
      .filter((k) => (!prefix || k.startsWith(prefix)) && (!cursor || k > cursor))
      .sort();
    const page = all.slice(0, limit ?? 1000);
    const next = all.slice(page.length);
    return {
      keys: page.map((name) => ({ name })),
      cursor: next.length > 0 ? next[0] : undefined,
    };
  }
}

export class MockR2Object {
  constructor(
    public key: string,
    public value: Uint8Array,
    public httpMetadata?: { contentType?: string }
  ) {}

  get size(): number {
    return this.value.byteLength;
  }

  get body(): Uint8Array {
    return this.value;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.value.buffer.slice(this.value.byteOffset, this.value.byteOffset + this.value.byteLength) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.value);
  }
}

export class MockR2 {
  private map = new Map<string, MockR2Object>();

  async get(key: string): Promise<MockR2Object | null> {
    return this.map.get(key) ?? null;
  }

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<void> {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : new Uint8Array(value);
    this.map.set(key, new MockR2Object(key, bytes, options?.httpMetadata));
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.map.delete(key);
    }
  }

  async list({ prefix, cursor, limit }: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{
    objects: MockR2Object[];
    cursor?: string;
  }> {
    const all = Array.from(this.map.keys())
      .filter((k) => (!prefix || k.startsWith(prefix)) && (!cursor || k > cursor))
      .sort();
    const page = all.slice(0, limit ?? 1000);
    const next = all.slice(page.length);
    return {
      objects: page.map((k) => this.map.get(k)!),
      cursor: next.length > 0 ? next[0] : undefined,
    };
  }
}
