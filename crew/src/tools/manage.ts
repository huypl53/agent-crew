import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { selectMultiple, selectOne } from '../cli/interactive.ts';
import type { Agent, Room, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getDb } from '../state/db.ts';
import { getAgentByRoomAndName, getRoomMembers } from '../state/index.ts';
import { handleClearWorkerSession } from './clear-worker-session.ts';
import { handleDeleteRoom } from './delete-room.ts';
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

interface ManageParams {
  name?: string;
  stdin?: Readable;
  stdout?: Writable;
}

export async function handleManage(params: ManageParams): Promise<ToolResult> {
  const { name } = params;
  if (!name) {
    return err('Missing required param: name');
  }

  const stdin = params.stdin ?? process.stdin;
  const stdout = params.stdout ?? process.stdout;

  const isTTYIn = !!(stdin as { isTTY?: boolean }).isTTY;
  const isTTYOut = !!(stdout as { isTTY?: boolean }).isTTY;
  if (!isTTYIn || !isTTYOut) {
    return err('Interactive console requires a TTY terminal');
  }

  while (true) {
    const db = getDb();
    const rooms = db
      .query(`
      SELECT DISTINCT r.* FROM rooms r
      JOIN agents a ON a.room_id = r.id
      WHERE a.name = ?
    `)
      .all(name) as Room[];

    if (rooms.length === 0) {
      stdout.write(
        'You are not a member of any active rooms. Join a room first.\n',
      );
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
  callerName: string,
  stdin: Readable,
  stdout: Writable,
): Promise<void> {
  while (true) {
    const callerInRoom = getAgentByRoomAndName(room.id, callerName);
    const isLeader = callerInRoom?.role === 'leader';

    const actions = [
      ...(isLeader
        ? [
            { value: 'members', label: 'Manage members (Single)' },
            { value: 'bulk-members', label: 'Manage members (Bulk)' },
            { value: 'topic', label: 'Set room topic' },
          ]
        : []),
      { value: 'leave', label: 'Leave room' },
      ...(isLeader ? [{ value: 'delete', label: 'Delete room' }] : []),
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

    if (action === 'leave') {
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
          name: callerName,
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
          name: callerName,
        });
        if (result.isError) {
          const errMsg = result.content[0]?.text || 'Error setting topic';
          stdout.write(`Error setting topic: ${errMsg}\n`);
        } else {
          stdout.write(`Successfully updated topic for room "${room.name}"\n`);
        }
      }
    } else if (action === 'members') {
      await manageMembersMenu(room, callerName, stdin, stdout);
    } else if (action === 'bulk-members') {
      await manageBulkMembersMenu(room, callerName, stdin, stdout);
    }
  }
}

async function manageMembersMenu(
  room: Room,
  callerName: string,
  stdin: Readable,
  stdout: Writable,
): Promise<void> {
  while (true) {
    const members = getRoomMembers(room.id).filter(
      (m) => m.name !== callerName && m.role === 'worker',
    );
    if (members.length === 0) {
      stdout.write('No workers in this room.\n');
      break;
    }

    const memberChoices = members.map((m) => ({
      value: m,
      label: `${m.name} (${m.role}) - status: ${m.status ?? 'idle'}`,
    }));

    const selectedMember = await selectOne<Agent | 'back'>({
      title: 'Select a worker to manage',
      items: [...memberChoices, { value: 'back', label: 'Back' }],
      stdin,
      stdout,
    });

    if (!selectedMember || selectedMember === 'back') {
      break;
    }

    const memberActions = [
      { value: 'interrupt', label: 'Interrupt Worker' },
      { value: 'clear', label: 'Clear Session' },
      { value: 'reassign', label: 'Reassign Task' },
      { value: 'back', label: 'Back' },
    ];

    const action = await selectOne<string>({
      title: `Worker: ${selectedMember.name} - Select action`,
      items: memberActions,
      stdin,
      stdout,
    });

    if (!action || action === 'back') {
      continue;
    }

    if (action === 'interrupt') {
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
    }
  }
}

async function manageBulkMembersMenu(
  room: Room,
  callerName: string,
  stdin: Readable,
  stdout: Writable,
): Promise<void> {
  while (true) {
    const members = getRoomMembers(room.id).filter(
      (m) => m.name !== callerName && m.role === 'worker',
    );
    if (members.length === 0) {
      stdout.write('No workers in this room.\n');
      break;
    }

    const actions = [
      { value: 'interrupt', label: 'Bulk Interrupt Workers' },
      { value: 'clear', label: 'Bulk Clear Sessions' },
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

    const memberChoices = members.map((m) => ({
      value: m.name,
      label: `${m.name} (${m.role})`,
    }));

    if (action === 'interrupt') {
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
    }
  }
}
