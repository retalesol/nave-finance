/**
 * Type compatibility shim for recharts 2.x with React 19 / TypeScript 5.1+.
 * TS2786 fires because recharts 2.x class components have a shouldComponentUpdate
 * signature that differs from what React 19 @types/react expects for JSX.
 * Redeclaring the problematic components as FC<any> resolves the JSX check.
 */
declare module 'recharts' {
  import type { FC, ReactNode, CSSProperties } from 'react';

  export const AreaChart: FC<any>;
  export const BarChart: FC<any>;
  export const LineChart: FC<any>;
  export const PieChart: FC<any>;
  export const RadarChart: FC<any>;
  export const ScatterChart: FC<any>;
  export const ComposedChart: FC<any>;
  export const RadialBarChart: FC<any>;
  export const FunnelChart: FC<any>;
  export const Treemap: FC<any>;

  export const Area: FC<any>;
  export const Bar: FC<any>;
  export const Line: FC<any>;
  export const Pie: FC<any>;
  export const Radar: FC<any>;
  export const Scatter: FC<any>;
  export const RadialBar: FC<any>;
  export const Funnel: FC<any>;

  export const XAxis: FC<any>;
  export const YAxis: FC<any>;
  export const ZAxis: FC<any>;
  export const CartesianGrid: FC<any>;
  export const Tooltip: FC<any>;
  export const Legend: FC<any>;
  export const Cell: FC<any>;
  export const ReferenceLine: FC<any>;
  export const ReferenceDot: FC<any>;
  export const ReferenceArea: FC<any>;
  export const ResponsiveContainer: FC<any>;
  export const Label: FC<any>;
  export const LabelList: FC<any>;
  export const Brush: FC<any>;
  export const ErrorBar: FC<any>;
  export const Cross: FC<any>;
  export const Customized: FC<any>;
  export const PolarAngleAxis: FC<any>;
  export const PolarGrid: FC<any>;
  export const PolarRadiusAxis: FC<any>;
  export const Sector: FC<any>;
  export const Curve: FC<any>;
  export const Rectangle: FC<any>;
  export const Dot: FC<any>;
  export const Layer: FC<any>;
  export const Surface: FC<any>;
  export const Text: FC<any>;

  export interface LegendProps {
    payload?: Array<{
      value: any;
      id?: string;
      type?: string;
      color?: string;
      payload?: { strokeDasharray?: string | number; value?: any };
      formatter?: (value: any, entry: any, index: number) => any;
      dataKey?: string | number | ((obj: any) => any);
    }>;
    verticalAlign?: 'top' | 'middle' | 'bottom';
    align?: 'left' | 'center' | 'right';
    layout?: 'horizontal' | 'vertical';
    iconSize?: number;
    iconType?: string;
    content?: any;
    formatter?: (value: any, entry: any, index: number) => any;
    wrapperStyle?: React.CSSProperties;
    width?: number;
    height?: number;
  }

  export interface TooltipProps<TValue = any, TName = any> {
    active?: boolean;
    payload?: Array<{ name: TName; value: TValue; unit?: string; color?: string; [key: string]: any }>;
    label?: any;
    content?: any;
    formatter?: (value: TValue, name: TName, props: any) => any;
    labelFormatter?: (label: any) => any;
    itemSorter?: (item: any) => number | string;
    [key: string]: any;
  }
}
