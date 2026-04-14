export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(b.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function del<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'DELETE' });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(b.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}
