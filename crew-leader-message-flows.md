# Crew - Luồng message vào Leader (Goal-related focus)

```mermaid
flowchart TD
  %% ===== Event Sources =====
  subgraph U1["User & CLI commands"]
    A["send-message"]
    B["send-batch"]
    C["input-block on/off"]
    D["reassign-task or interrupt-worker"]
  end

  subgraph H1["Hooks"]
    E["UserPromptSubmit + Stop hook"]
    F["Permission request hook"]
  end

  subgraph S1["System background/sweep"]
    G["sweep: idle/dead notify"]
    H["sweep: batch pending hint"]
    I["sweep: party timeout notify"]
    J["party: round complete"]
  end

  %% ===== Delivery / queue =====
  subgraph D1["Delivery primitives"]
    K["deliverMessage"]
    L["deliverToTarget"]
    M["deliverWithRetry"]
    N["flushPushQueueForAgent"]
    O["PaneQueue.enqueue (paste)"]
    P["sendKeys direct"]
  end

  %% ===== Goal state =====
  subgraph G1["Goal state"]
    Q["armLeaderGoalReminder"]
    R["consumeLeaderGoalReminder"]
    S["notifyLeadersOnWorkerStop"]
    T["tickGoalTurnCount"]
  end

  %% send-message
  A --> K
  K --> L
  L --> O
  L -->|target=leader or worker broadcast/metadata batch| Q
  Q --> R

  %% send-batch
  B --> K
  K --> Q2["queueBatchFinalDelivery"]
  Q2 --> K

  %% reassign / interrupt / input block
  C --> N
  C --> O
  D --> O

  %% stop hook from worker
  E -->|Stop worker| S
  S --> L2["addMessage broadcast + preview"]
  L2 --> M
  M --> O
  M -->|onQueueDrain when arming needed| Q

  %% stop hook from leader
  E -->|Stop leader| R
  R --> T
  R --> P

  %% permission dialog hook
  F --> P

  %% input unblock path
  C -->|off/unblock| N
  N -->|last armable message| Q

  %% sweep flows
  G --> U2["collect worker statuses"]
  H --> U2
  U2 --> O
  J --> K2["deliverPartyDigest"]
  K2 --> P
  I --> K3["leader tmux direct enqueue"]
  K3 --> P

  %% party mode branch
  S -->|capture response then check| J
  J --> K2

  %% styling
  classDef unstable fill:#ffe8e8,stroke:#cc0000,stroke-width:2px,color:#7a0000;
  class O,R,P unstable
```

## Legend
- `M` = qua `PaneQueue.enqueue`, queue-drain semantics.
- `N` = gửi trực tiếp `sendKeys`, bỏ qua queue (không đi qua onQueueDrain).
- `O/P` = state goal `leader_reminder_armed`.

## Các luồng vào leader (thực tế)
1. `send-message`:
   - user command → `deliverMessage` → `deliverToTarget` → `PaneQueue.enqueue`.
   - Nếu target là leader và (`sender=worker` hoặc `metadata.batch_id`) thì gắn `onQueueDrain => armLeaderGoalReminder`.
2. `send-batch`:
   - worker stop message có `batch_id` đi vào `deliverMessage`.
   - Khi batch hoàn tất trong state flow, gọi `queueBatchFinalDelivery` rồi đẩy tới leader bằng `deliverMessage`.
3. `notifyLeadersOnWorkerStop`:
   - từ hook `Stop` của worker nếu không có goal active của worker.
   - Tạo `messages` + preview cho leader.
   - Dùng `deliverWithRetry` -> `PaneQueue.enqueue(skipLeaderPacing, onQueueDrain=armLeaderGoalReminder)`.
4. `flushPushQueueForAgent`:
   - chạy khi unblocking input (`input-block off`) hoặc hook vừa hết blocked.
   - duyệt backlog, enqueue từng message; arm reminder **chỉ** trên message có `sender_role='worker'` hoặc `batch_id != null` mới nhất.
5. `party`/`sweep`/`dialog`:
   - `deliverPartyDigest`, `sweep` idle timeout/idle notify, `notifyPartyTimeout`.
   - `F` permission dialog vào leader qua `sendKeys` trực tiếp.

## Chỗ P2 không ổn định (đã tách rõ)
- P2 có liên quan tới khả năng `onQueueDrain` không chạy nhất quán khi hàng đợi chưa thực sự trống tại đúng thời điểm.
- Đặc biệt khi enqueue cùng lúc nhiều entry (preview, retry, hint/bulk notify…), điều kiện callback chỉ gắn cho phần tử được coi là drain-final nên cờ `leader_reminder_armed` có thể không bật đủ mỗi lần cần.
- Trong chart, các edge qua `M` có dấu hiệu unstable vì phụ thuộc vào queue-drain order.
