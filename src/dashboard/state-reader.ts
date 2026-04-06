import { watch, type FSWatcher } from 'fs';
import type { Agent, Room, Message } from '../shared/types.ts';

const STATE_DIR = '/tmp/cc-tmux/state';

export interface DashboardState {
  agents: Record<string, Agent>;
  rooms: Record<string, Room>;
  messages: Message[];
}

export type StateChangeHandler = (state: DashboardState) => void;

export class StateReader {
  private state: DashboardState = { agents: {}, rooms: {}, messages: [] };
  private watcher: FSWatcher | null = null;
  private onChange: StateChangeHandler | null = null;
  private stateExists = false;

  get current(): DashboardState { return this.state; }
  get isAvailable(): boolean { return this.stateExists; }

  async init(): Promise<DashboardState> {
    await this.readAll();
    this.startWatching();
    return this.state;
  }

  setChangeHandler(handler: StateChangeHandler): void {
    this.onChange = handler;
  }

  private async readAll(): Promise<void> {
    if (!await this.checkDir()) {
      this.stateExists = false;
      return;
    }
    this.stateExists = true;

    const [agents, rooms, messages] = await Promise.all([
      this.readJson<Record<string, Agent>>(`${STATE_DIR}/agents.json`, {}),
      this.readJson<Record<string, Room>>(`${STATE_DIR}/rooms.json`, {}),
      this.readJson<Message[]>(`${STATE_DIR}/messages.json`, []),
    ]);
    this.state = { agents, rooms, messages };
  }

  private async checkDir(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['test', '-d', STATE_DIR], { stdout: 'pipe', stderr: 'pipe' });
      return (await proc.exited) === 0;
    } catch { return false; }
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      const file = Bun.file(path);
      if (!await file.exists()) return fallback;
      return JSON.parse(await file.text()) as T;
    } catch {
      try {
        await Bun.sleep(50);
        return JSON.parse(await Bun.file(path).text()) as T;
      } catch { return fallback; }
    }
  }

  private startWatching(): void {
    try {
      this.watcher = watch(STATE_DIR, { persistent: false }, async (_event, filename) => {
        if (filename?.endsWith('.json')) {
          await this.readAll();
          this.onChange?.(this.state);
        }
      });
      this.watcher.on('error', () => { this.stateExists = false; });
    } catch {
      this.pollForDir();
    }
  }

  private pollForDir(): void {
    const check = setInterval(async () => {
      if (await this.checkDir()) {
        clearInterval(check);
        await this.readAll();
        this.startWatching();
        this.onChange?.(this.state);
      }
    }, 2000);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
