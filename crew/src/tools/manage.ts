import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { selectMultiple, selectOne } from '../cli/interactive.ts';
import type { Agent, Room, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getDb } from '../state/db.ts';
import {
  getAgent,
  getAgentByRoomAndName,
  getGoalHistory,
  getRoomGoalOverview,
  getRoomMembers,
} from '../state/index.ts';
import { handleClearWorkerSession } from './clear-worker-session.ts';
import { handleDeleteRoom } from './delete-room.ts';
import {
  handleGoalDone,
  handleGoalLookup,
  handleGoalSet,
  handleGoalUnset,
} from './goal.ts';
import { handleInterruptWorker } from './interrupt-worker.ts';
import { handleLeaveRoom } from './leave-room.ts';
import { handleReassignTask } from './reassign-task.ts';
import { handleSetRoomTopic } from './set-room-topic.ts';

function promptText(
  stdin: Readable,
  stdout: Writable,
  query: string,
): Promise<string | null> {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
    rl.on('SIGINT', () => {
      rl.close();
      resolve(null);
    });
  });
}

/** Unwrap an error message from a ToolResult, defaulting to a generic string. */
function resultError(result: ToolResult, fallback: string): string {
  const text = result.content[0]?.text;
  if (!text) return fallback;
  try {
    return JSON.parse(text).error ?? fallback;
  } catch {
    return text;
  }
}

interface ManageParams {
  name?: string;
  stdin?: Readable;
  stdout?: Writable;
}

function getOrRegisterLeader(roomId: number): string {
  const db = getDb();

  // Look for any registered leader in this room
  const roomMembers = getRoomMembers(roomId);
  const existingLeader = roomMembers.find((m) => m.role === 'leader');
  if (existingLeader) {
    return existingLeader.name;
  }

  // If no leader exists in the room, we can create a virtual/temporary leader agent named `operator`.
  const operatorName = 'operator';
  const existingOperator = roomMembers.find((m) => m.name === operatorName);
  if (existingOperator) {
    if (existingOperator.role !== 'leader') {
      db.run('UPDATE agents SET role = ? WHERE id = ?', [
        'leader',
        existingOperator.agent_id,
      ]);
    }
    return operatorName;
  }

  // Register 'operator' as a leader agent in this room
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO agents (room_id, name, role, agent_type, registered_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [roomId, operatorName, 'leader', 'unknown', ts, 'idle'],
  );
  return operatorName;
}

export async function handleManage(params: ManageParams): Promise<ToolResult> {
  const { name } = params;

  const stdin = params.stdin ?? process.stdin;
  const stdout = params.stdout ?? process.stdout;

  const isTTYIn = !!(stdin as { isTTY?: boolean }).isTTY;
  const isTTYOut = !!(stdout as { isTTY?: boolean }).isTTY;
  if (!isTTYIn || !isTTYOut) {
    return err('Interactive console requires a TTY terminal');
  }

  while (true) {
    const db = getDb();
    let rooms: Room[];
    if (name) {
      rooms = db
        .query(`
        SELECT DISTINCT r.* FROM rooms r
        JOIN agents a ON a.room_id = r.id
        WHERE a.name = ?
      `)
        .all(name) as Room[];
    } else {
      rooms = db
        .query(`
        SELECT * FROM rooms
      `)
        .all() as Room[];
    }

    if (rooms.length === 0) {
      if (name) {
        stdout.write(
          `Agent "${name}" is not a member of any active rooms. Join a room first.\n`,
        );
      } else {
        stdout.write('No active rooms found. Create/join a room first.\n');
      }
      break;
    }

    const roomChoices = rooms.map((r) => ({
      value: r,
      label: `${r.name} (${r.path})`,
    }));

    const selectedRoom = await selectOne<Room>({
      title: 'Select a room to manage',
      items: roomChoices,
      stdin,
      stdout,
    });

    if (!selectedRoom) {
      break;
    }

    await manageRoomMenu(selectedRoom, name, stdin, stdout);
  }

  return ok({ success: true });
}

async function manageRoomMenu(
  room: Room,
  callerName: string | undefined,
  stdin: Readable,
  stdout: Writable,
): Promise<void> {
  while (true) {
    let isLeader = true;
    let effectiveCallerName = '';
    const isOperator = !callerName;

    if (callerName) {
      const callerInRoom = getAgentByRoomAndName(room.id, callerName);
      isLeader = callerInRoom?.role === 'leader';
      effectiveCallerName = callerName;
    } else {
      effectiveCallerName = getOrRegisterLeader(room.id);
      isLeader = true;
    }

    const actions = [
      ...(isLeader
        ? [
            { value: 'members', label: 'Manage members (Single)' },
            { value: 'bulk-members', label: 'Manage members (Bulk)' },
            { value: 'topic', label: 'Set room topic' },
          ]
        : []),
      ...(callerName ? [{ value: 'leave', label: 'Leave room' }] : []),
      ...(isLeader ? [{ value: 'delete', label: 'Delete room' }] : []),
      // Goal overview is read-only oversight — keep it last (before Back) so it
      // doesn't shift the indices of the action items the existing tests drive.
      { value: 'goals', label: 'View all goals (overview)' },
      { value: 'back', label: 'Back' },
    ];

    const action = await selectOne<string>({
      title: `Room: ${room.name} - Select action`,
      items: actions,
      stdin,
      stdout,
    });

    if (!action || action === 'back') {
      break;
    }

    if (action === 'leave' && callerName) {
      const result = await handleLeaveRoom({
        room: room.name,
        name: callerName,
      });
      if (result.isError) {
        const errMsg = result.content[0]?.text || 'Error leaving room';
        stdout.write(`Error leaving room: ${errMsg}\n`);
      } else {
        stdout.write(`Successfully left room "${room.name}"\n`);
        break; // Leave menu since we left the room
      }
    } else if (action === 'delete') {
      const confirmChoice = await selectOne<boolean>({
        title: `Are you sure you want to delete room "${room.name}"? This removes all members and messages.`,
        items: [
          { value: true, label: 'Yes, delete room' },
          { value: false, label: 'No, cancel' },
        ],
        stdin,
        stdout,
      });

      if (confirmChoice === true) {
        const result = await handleDeleteRoom({
          room: room.name,
          confirm: true,
          name: effectiveCallerName,
        });
        if (result.isError) {
          const errMsg = result.content[0]?.text || 'Error deleting room';
          stdout.write(`Error deleting room: ${errMsg}\n`);
        } else {
          stdout.write(`Successfully deleted room "${room.name}"\n`);
          break; // Leave menu since room is deleted
        }
      }
    } else if (action === 'topic') {
      const newTopic = await promptText(stdin, stdout, 'Enter new topic: ');
      if (newTopic !== null) {
        const result = await handleSetRoomTopic({
          room: room.name,
          text: newTopic,
          name: effectiveCallerName,
        });
        if (result.isError) {
          const errMsg = result.content[0]?.text || 'Error setting topic';
          stdout.write(`Error setting topic: ${errMsg}\n`);
        } else {
          stdout.write(`Successfully updated topic for room "${room.name}"\n`);
        }
      }
    } else if (action === 'goals') {
      await viewRoomGoals(room, stdin, stdout);
    } else if (action === 'members') {
      await manageMembersMenu(
        room,
        effectiveCallerName,
        stdin,
        stdout,
        isOperator,
      );
    } else if (action === 'bulk-members') {
      await manageBulkMembersMenu(
        room,
        effectiveCallerName,
        stdin,
        stdout,
        isOperator,
      );
    }
  }
}

/** Room-level goal overview: print each member's latest goal. */
async function viewRoomGoals(
  room: Room,
  _stdin: Readable,
  stdout: Writable,
): Promise<void> {
  const overview = getRoomGoalOverview(room.id);

  stdout.write(`\nGoals in room "${room.name}":\n`);
  if (overview.length === 0) {
    stdout.write('  (no goals set)\n');
  }
  for (const { goal: g } of overview) {
    const mark = g.status === 'active' ? '🎯' : '  ';
    stdout.write(
      `  ${mark} ${g.agent_name}: "${g.description}" (${g.status}, turn ${g.turn_count})\n`,
    );
  }
  stdout.write('\n');
}

async function manageMembersMenu(
  room: Room,
  callerName: string,
  stdin: Readable,
  stdout: Writable,
  isOperator: boolean,
): Promise<void> {
  while (true) {
    const members = getRoomMembers(room.id).filter((m) =>
      isOperator ? true : m.name !== callerName,
    );
    if (members.length === 0) {
      stdout.write('No other members in this room.\n');
      break;
    }

    const memberChoices = members.map((m) => ({
      value: m,
      label: `${m.name} (${m.role}) - status: ${m.status ?? 'idle'}`,
    }));

    const selectedMember = await selectOne<Agent | 'back'>({
      title: 'Select a member to manage',
      items: [...memberChoices, { value: 'back', label: 'Back' }],
      stdin,
      stdout,
    });

    if (!selectedMember || selectedMember === 'back') {
      break;
    }

    const memberActions = [
      ...(selectedMember.role === 'worker'
        ? [
            { value: 'interrupt', label: 'Interrupt Worker' },
            { value: 'clear', label: 'Clear Session' },
            { value: 'reassign', label: 'Reassign Task' },
          ]
        : []),
      { value: 'remove', label: 'Remove from Room' },
      // Goal actions are clustered last (before Back) so they don't shift the
      // indices of the existing worker/control actions the tests navigate to.
      { value: 'view-goal', label: 'View goal' },
      { value: 'set-goal', label: 'Set goal' },
      { value: 'redo-goal', label: 'Reactivate goal from history' },
      { value: 'done-goal', label: 'Mark goal done' },
      { value: 'unset-goal', label: 'Unset goal' },
      { value: 'back', label: 'Back' },
    ];

    const action = await selectOne<string>({
      title: `Member: ${selectedMember.name} (${selectedMember.role}) - Select action`,
      items: memberActions,
      stdin,
      stdout,
    });

    if (!action || action === 'back') {
      continue;
    }

    if (action === 'remove') {
      const result = await handleLeaveRoom({
        room: room.name,
        name: selectedMember.name,
      });
      if (result.isError) {
        const errMsg = result.content[0]?.text || 'Error';
        stdout.write(`Error: ${errMsg}\n`);
      } else {
        stdout.write(
          `Successfully removed ${selectedMember.name} from room ${room.name}\n`,
        );
      }
    } else if (action === 'interrupt') {
      const result = await handleInterruptWorker({
        worker_name: selectedMember.name,
        room: room.name,
        name: callerName,
      });
      if (result.isError) {
        const errMsg = result.content[0]?.text || 'Error';
        stdout.write(`Error: ${errMsg}\n`);
      } else {
        stdout.write(
          `Successfully interrupted worker ${selectedMember.name}\n`,
        );
      }
    } else if (action === 'clear') {
      const result = await handleClearWorkerSession({
        worker_name: selectedMember.name,
        room: room.name,
        name: callerName,
      });
      if (result.isError) {
        const errMsg = result.content[0]?.text || 'Error';
        stdout.write(`Error: ${errMsg}\n`);
      } else {
        stdout.write(
          `Successfully cleared session for ${selectedMember.name}\n`,
        );
      }
    } else if (action === 'reassign') {
      const text = await promptText(
        stdin,
        stdout,
        'Enter new assignment/instruction: ',
      );
      if (text !== null) {
        const result = await handleReassignTask({
          worker_name: selectedMember.name,
          room: room.name,
          text,
          name: callerName,
        });
        if (result.isError) {
          const errMsg = result.content[0]?.text || 'Error';
          stdout.write(`Error: ${errMsg}\n`);
        } else {
          stdout.write(
            `Successfully reassigned task to ${selectedMember.name}\n`,
          );
        }
      }
    } else if (action === 'view-goal') {
      const r = await handleGoalLookup({
        agent: selectedMember.name,
        room: room.name,
      });
      const d = JSON.parse(r.content[0]?.text ?? '{}');
      stdout.write(
        d.goal
          ? `  🎯 ${selectedMember.name}: "${d.goal.description}" (${d.goal.status}, turn ${d.goal.turn_count ?? 0})\n`
          : `  ${selectedMember.name} has no goal.\n`,
      );
    } else if (action === 'set-goal') {
      const desc = await promptText(stdin, stdout, 'Enter goal description: ');
      if (desc !== null) {
        const r = await handleGoalSet({
          agent: selectedMember.name,
          room: room.name,
          message: desc,
        });
        stdout.write(
          r.isError
            ? `Error: ${resultError(r, 'set goal failed')}\n`
            : `Goal set for ${selectedMember.name}\n`,
        );
      }
    } else if (action === 'redo-goal') {
      await reactivateGoalMenu(room, selectedMember.name, stdin, stdout);
    } else if (action === 'done-goal') {
      const r = await handleGoalDone({
        agent: selectedMember.name,
        room: room.name,
      });
      stdout.write(
        r.isError
          ? `Error: ${resultError(r, 'done goal failed')}\n`
          : `Goal marked done for ${selectedMember.name}\n`,
      );
    } else if (action === 'unset-goal') {
      const r = await handleGoalUnset({
        agent: selectedMember.name,
        room: room.name,
      });
      stdout.write(
        r.isError
          ? `Error: ${resultError(r, 'unset goal failed')}\n`
          : `Goal removed for ${selectedMember.name}\n`,
      );
    }
  }
}

/** Interactive picker: reactivate one of the member's past goals. */
async function reactivateGoalMenu(
  room: Room,
  agentName: string,
  stdin: Readable,
  stdout: Writable,
): Promise<void> {
  const history = getGoalHistory(room.id, { agentName, limit: 50 });
  if (history.length === 0) {
    stdout.write(`  No goal history for ${agentName}.\n`);
    return;
  }
  type GoalRow = (typeof history)[number];
  const items: Array<{ value: GoalRow | null; label: string }> = history.map(
    (g) => ({
      value: g as GoalRow,
      label: `[${g.id}] "${g.description}" (${g.status}, turn ${g.turn_count ?? 0})`,
    }),
  );
  items.push({ value: null, label: 'Cancel' });

  const picked = await selectOne<GoalRow | null>({
    title: `Reactivate a past goal for ${agentName}`,
    items,
    stdin,
    stdout,
  });
  if (!picked) return;

  const r = await handleGoalSet({
    agent: agentName,
    room: room.name,
    message: picked.description,
  });
  stdout.write(
    r.isError
      ? `Error: ${resultError(r, 'reactivate failed')}\n`
      : `Reactivated goal #${picked.id} for ${agentName}\n`,
  );
}

async function manageBulkMembersMenu(
  room: Room,
  callerName: string,
  stdin: Readable,
  stdout: Writable,
  isOperator: boolean,
): Promise<void> {
  while (true) {
    const members = getRoomMembers(room.id).filter((m) =>
      isOperator ? true : m.name !== callerName,
    );
    if (members.length === 0) {
      stdout.write('No other members in this room.\n');
      break;
    }

    const actions = [
      { value: 'interrupt', label: 'Bulk Interrupt Workers' },
      { value: 'clear', label: 'Bulk Clear Sessions' },
      { value: 'remove', label: 'Bulk Remove from Room' },
      { value: 'back', label: 'Back' },
    ];

    const action = await selectOne<string>({
      title: 'Bulk Member Actions - Select action',
      items: actions,
      stdin,
      stdout,
    });

    if (!action || action === 'back') {
      break;
    }

    if (action === 'interrupt') {
      const workersOnly = members.filter((m) => m.role === 'worker');
      if (workersOnly.length === 0) {
        stdout.write('No workers in this room to interrupt.\n');
        continue;
      }
      const memberChoices = workersOnly.map((m) => ({
        value: m.name,
        label: `${m.name} (${m.role})`,
      }));
      const selectedNames = await selectMultiple<string>({
        title:
          'Select workers to interrupt (Space to select, Enter to confirm)',
        items: memberChoices,
        stdin,
        stdout,
      });

      if (selectedNames && selectedNames.length > 0) {
        for (const worker_name of selectedNames) {
          const result = await handleInterruptWorker({
            worker_name,
            room: room.name,
            name: callerName,
          });
          if (result.isError) {
            const errMsg = result.content[0]?.text || 'Error';
            stdout.write(`Error interrupting ${worker_name}: ${errMsg}\n`);
          } else {
            stdout.write(`Successfully interrupted ${worker_name}\n`);
          }
        }
      }
    } else if (action === 'clear') {
      const workersOnly = members.filter((m) => m.role === 'worker');
      if (workersOnly.length === 0) {
        stdout.write('No workers in this room to clear.\n');
        continue;
      }
      const memberChoices = workersOnly.map((m) => ({
        value: m.name,
        label: `${m.name} (${m.role})`,
      }));
      const selectedNames = await selectMultiple<string>({
        title:
          'Select workers to clear session (Space to select, Enter to confirm)',
        items: memberChoices,
        stdin,
        stdout,
      });

      if (selectedNames && selectedNames.length > 0) {
        for (const worker_name of selectedNames) {
          const result = await handleClearWorkerSession({
            worker_name,
            room: room.name,
            name: callerName,
          });
          if (result.isError) {
            const errMsg = result.content[0]?.text || 'Error';
            stdout.write(`Error clearing ${worker_name} session: ${errMsg}\n`);
          } else {
            stdout.write(`Successfully cleared session for ${worker_name}\n`);
          }
        }
      }
    } else if (action === 'remove') {
      const memberChoices = members.map((m) => ({
        value: m.name,
        label: `${m.name} (${m.role})`,
      }));
      const selectedNames = await selectMultiple<string>({
        title:
          'Select members to remove from room (Space to select, Enter to confirm)',
        items: memberChoices,
        stdin,
        stdout,
      });

      if (selectedNames && selectedNames.length > 0) {
        for (const name of selectedNames) {
          const result = await handleLeaveRoom({
            room: room.name,
            name,
          });
          if (result.isError) {
            const errMsg = result.content[0]?.text || 'Error';
            stdout.write(`Error removing ${name}: ${errMsg}\n`);
          } else {
            stdout.write(
              `Successfully removed ${name} from room ${room.name}\n`,
            );
          }
        }
      }
    }
  }
}
