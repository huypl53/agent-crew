import React from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../hooks/useTree.ts';

const STATUS_COLORS: Record<string, string> = {
  idle: 'green', busy: 'yellow', dead: 'red', unknown: 'gray',
};

interface TreePanelProps {
  nodes: TreeNode[];
  selectedIndex: number;
  height: number;
}

export function TreePanel({ nodes, selectedIndex, height }: TreePanelProps) {
  const maxLines = Math.max(1, height - 2); // border top/bottom
  let startIdx = 0;
  if (selectedIndex >= maxLines) startIdx = selectedIndex - maxLines + 1;
  const visible = nodes.slice(startIdx, startIdx + maxLines);

  return (
    <Box flexDirection="column" borderStyle="single" width="30%" height={height}>
      {visible.map((node, i) => {
        const globalIdx = startIdx + i;
        const isSel = globalIdx === selectedIndex;

        if (node.type === 'room') {
          return (
            <Text key={node.id} inverse={isSel}>
              {' '}{node.collapsed ? '▶' : '▼'} {node.label} ({node.memberCount})
            </Text>
          );
        }

        const color = STATUS_COLORS[node.status ?? 'unknown'] ?? 'gray';
        const dot = node.secondary ? '◦' : '●';
        const roleSuffix = node.role ? ` (${node.role})` : '';

        return (
          <Text key={node.id} inverse={isSel} dimColor={node.secondary}>
            {'   '}<Text color={node.secondary ? 'gray' : color}>{dot}</Text> {node.label}<Text dimColor>{roleSuffix}</Text>
          </Text>
        );
      })}
      {startIdx > 0 && <Text dimColor>{'  '}▲ more</Text>}
      {startIdx + maxLines < nodes.length && <Text dimColor>{'  '}▼ more</Text>}
    </Box>
  );
}
