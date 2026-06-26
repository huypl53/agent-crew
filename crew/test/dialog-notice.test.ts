import { describe, expect, test } from 'bun:test';
import {
  extractDialogFromPermission,
  formatLeaderNotice,
} from '../src/tools/dialog-notice.ts';

describe('extractDialogFromPermission', () => {
  test('identifies AskUserQuestion and parses questions', () => {
    const ex = extractDialogFromPermission({
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red' }, { label: 'Green', description: 'eco' }],
          },
        ],
      },
    });
    expect(ex).not.toBeNull();
    expect(ex!.dialogType).toBe('ask_question');
    expect(ex!.toolName).toBe('AskUserQuestion');
    const firstQuestion = ex!.questions?.[0];
    expect(firstQuestion).toBeDefined();
    expect(firstQuestion?.question).toBe('Pick a color');
    expect(firstQuestion?.header).toBe('Color');
    expect(firstQuestion?.multiSelect).toBe(false);
    expect(firstQuestion?.options.map((o) => o.label)).toEqual([
      'Red',
      'Green',
    ]);
    expect(firstQuestion?.options[1]?.description).toBe('eco');
  });

  test('identifies ExitPlanMode as plan approval', () => {
    const ex = extractDialogFromPermission({
      tool_name: 'ExitPlanMode',
      tool_input: {},
    });
    expect(ex).not.toBeNull();
    expect(ex!.dialogType).toBe('plan_approval');
    expect(ex!.questions).toBeNull();
  });

  test('returns null for ordinary permission requests', () => {
    expect(
      extractDialogFromPermission({ tool_name: 'Bash', tool_input: {} }),
    ).toBeNull();
    expect(
      extractDialogFromPermission({ tool_name: 'Write', tool_input: {} }),
    ).toBeNull();
  });

  test('returns null when tool_input has no questions array', () => {
    expect(
      extractDialogFromPermission({
        tool_name: 'AskUserQuestion',
        tool_input: {},
      }),
    ).toBeNull();
  });

  test('handles missing tool_name', () => {
    expect(extractDialogFromPermission({ tool_input: {} })).toBeNull();
  });
});

describe('formatLeaderNotice', () => {
  test('renders numbered options + single-select answer command', () => {
    const notice = formatLeaderNotice({
      workerName: 'worker-1',
      dialogType: 'ask_question',
      questions: [
        {
          question: 'Which lib?',
          header: 'Library',
          multiSelect: false,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        },
      ],
    });
    expect(notice).toContain('Library');
    expect(notice).toContain('single-select');
    expect(notice).toContain('[1/1]');
    expect(notice).toContain('[1] A');
    expect(notice).toContain('[2] B');
    expect(notice).toContain('[3] C');
    expect(notice).toContain('crew dialog answer worker-1 --pick N');
  });

  test('uses multi-select answer command when multiSelect', () => {
    const notice = formatLeaderNotice({
      workerName: 'worker-1',
      dialogType: 'ask_question',
      questions: [
        {
          question: 'Pick many',
          header: '',
          multiSelect: true,
          options: [{ label: 'X' }, { label: 'Y' }],
        },
      ],
    });
    expect(notice).toContain('multi-select');
    expect(notice).toContain('--pick 1,2,…');
  });

  test('renders current question index when multi-question', () => {
    const notice = formatLeaderNotice({
      workerName: 'worker-1',
      dialogType: 'ask_question',
      questionIndex: 1,
      questions: [
        {
          question: 'q1',
          header: '',
          multiSelect: true,
          options: [{ label: 'A' }],
        },
        {
          question: 'q2',
          header: '',
          multiSelect: false,
          options: [{ label: 'B' }],
        },
      ],
    });
    expect(notice).toContain('[2/2]');
    expect(notice).toContain('q2');
  });

  test('renders approve command for plan approval', () => {
    const notice = formatLeaderNotice({
      workerName: 'worker-1',
      dialogType: 'plan_approval',
      questions: null,
    });
    expect(notice).toContain('requests plan approval');
    expect(notice).toContain('crew dialog approve worker-1');
  });

  test('falls back to pending hint when questions missing', () => {
    const notice = formatLeaderNotice({
      workerName: 'worker-1',
      dialogType: 'ask_question',
      questions: null,
    });
    expect(notice).toContain('crew dialog pending');
  });
});
