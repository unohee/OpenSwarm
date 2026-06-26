// TabBar — the 6-tab strip; highlights the active tab (EPIC INT-1813 S3).
import { Box, Text } from 'ink';
import { TABS } from '../tabs.js';

export interface TabBarProps {
  active: number;
}

export function TabBar({ active }: TabBarProps) {
  return (
    <Box>
      {TABS.map((tab, i) => (
        <Box key={tab.id} marginRight={1}>
          <Text inverse={i === active} color={i === active ? 'cyan' : undefined}>
            {` ${i + 1}:${tab.label} `}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
