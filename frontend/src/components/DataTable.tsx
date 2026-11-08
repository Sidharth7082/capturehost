import type { JSX, ReactNode } from 'react';
import './DataTable.css';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Dropped below 640px to keep rows readable on a phone. */
  hideOnMobile?: boolean;
  muted?: boolean;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  getRowKey: (row: T) => string | number;
  empty: ReactNode;
  caption?: string;
  onRowClick?: (row: T) => void;
}

/**
 * Generic table. Column definitions live in the page so this stays dumb and
 * reusable; it owns only layout, the empty state and hover/cursor behaviour.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  empty,
  caption,
  onRowClick,
}: DataTableProps<T>): JSX.Element {
  return (
    <div className="data-table">
      <table>
        {caption && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={[
                  column.align === 'right' ? 'data-table__cell--right' : '',
                  column.hideOnMobile ? 'data-table__cell--hide-mobile' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="data-table__empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={getRowKey(row)}
                data-clickable={onRowClick ? 'true' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={[
                      column.align === 'right' ? 'data-table__cell--right' : '',
                      column.muted ? 'data-table__cell--muted' : '',
                      column.hideOnMobile ? 'data-table__cell--hide-mobile' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
