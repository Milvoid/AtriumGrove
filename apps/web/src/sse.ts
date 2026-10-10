export interface StreamEvent {
  eventId: string;
  seq: string;
  type: string;
  payload: Record<string, any>;
}
export class EventReducer {
  private seen = new Set<string>();
  private generation = 0;
  seq = "0";
  begin() {
    return ++this.generation;
  }
  snapshot(generation: number, seq: string) {
    if (generation !== this.generation) return false;
    this.seq = seq;
    this.seen.clear();
    return true;
  }
  apply(generation: number, event: StreamEvent) {
    if (
      generation !== this.generation ||
      this.seen.has(event.eventId) ||
      BigInt(event.seq) <= BigInt(this.seq)
    )
      return false;
    this.seen.add(event.eventId);
    if (this.seen.size > 2000)
      this.seen.delete(this.seen.values().next().value!);
    this.seq = event.seq;
    return true;
  }
}
export async function streamEvents(
  workspaceId: string,
  after: string,
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
  onOpen: () => void = () => {},
) {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/events?after=${after}`,
    { signal },
  );
  if (response.status === 410) throw new Error("REPLAY_WINDOW_EXPIRED");
  if (!response.ok)
    throw new Error(
      response.status === 401 ? "LOGIN_REQUIRED" : "STREAM_UNAVAILABLE",
    );
  onOpen();
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) throw new Error("STREAM_CLOSED");
    buffer += decoder.decode(result.value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const packet = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = packet
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}
