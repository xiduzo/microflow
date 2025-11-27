import { type COLOR_ORDER } from 'node-pixel';

export type ColorOrder = keyof typeof COLOR_ORDER;
export const COLORS: ColorOrder[] = ['GRB', 'RGB', 'BRG'];
