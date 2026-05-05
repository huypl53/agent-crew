/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AgentInspector from './AgentInspector.tsx';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../hooks/useApi.ts', () => ({
  get: (...args: unknown[]) => getMock(...args),
  post: (...args: unknown[]) => postMock(...args),
}));

describe('AgentInspector onboarding', () => {
  it('opens modal, shows windows, selects window, and submits onboarding request', async () => {
    getMock.mockImplementation((path: string) => {
      if (path === '/rooms/crew') {
        return Promise.resolve({
          id: 1,
          path: '/tmp/crew',
          name: 'crew',
          member_count: 1,
          created_at: new Date().toISOString(),
          template_names: [],
        });
      }
      if (path === '/rooms/crew/members') {
        return Promise.resolve([]);
      }
      if (path === '/rooms/crew/tmux-windows') {
        return Promise.resolve({
          session: 'crew',
          active_window_index: 0,
          windows: [
            {
              index: 0,
              name: 'main',
              active: true,
              pane_count: 1,
              panes: [
                {
                  pane_id: '%1',
                  pane_index: 0,
                  title: 'leader',
                  active: true,
                },
              ],
            },
            {
              index: 1,
              name: 'workers',
              active: false,
              pane_count: 2,
              panes: [
                {
                  pane_id: '%2',
                  pane_index: 0,
                  title: 'wk-1',
                  active: false,
                },
                {
                  pane_id: '%3',
                  pane_index: 1,
                  title: 'wk-2',
                  active: false,
                },
              ],
            },
          ],
        });
      }
      if (path === '/rooms/crew/members') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    postMock.mockResolvedValue({ ok: true });

    render(
      <AgentInspector
        room="crew"
        templates={[
          {
            id: 11,
            name: 'worker-template',
            role: 'worker',
            created_at: new Date().toISOString(),
          },
        ]}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: /onboard agent from template/i,
      }),
    );

    expect(await screen.findByText('Onboard agent to #crew')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /\[1\] workers/i }));

    const nameInput = screen.getByPlaceholderText('Default: template name');
    fireEvent.change(nameInput, { target: { value: 'wk-new' } });

    fireEvent.click(screen.getByRole('button', { name: 'Onboard' }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/rooms/crew/onboard-agent', {
        templateId: 11,
        name: 'wk-new',
        windowIndex: 1,
      });
    });
  });
});
