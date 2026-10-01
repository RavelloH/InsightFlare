import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  type TableProps,
  TableRow,
} from "./table";

function createTableRows(
  rows: readonly {
    readonly path: string;
    readonly views: string;
    readonly change: string;
  }[],
) {
  return (
    <>
      <TableHeader>
        <TableRow>
          <TableHead>Page</TableHead>
          <TableHead className="text-right">Views</TableHead>
          <TableHead className="text-right">Change</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.path}>
            <TableCell>{row.path}</TableCell>
            <TableCell className="text-right tabular-nums">
              {row.views}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.change}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </>
  );
}

const tableFixtures = [
  {
    id: "table.scenario.analytics",
    title: "Analytics data",
    presentation: { kind: "scenario", scenario: "populated rows" },
    props: {
      children: createTableRows([
        { path: "/", views: "1,284", change: "+8.2%" },
        { path: "/pricing", views: "842", change: "+3.1%" },
        { path: "/docs", views: "509", change: "-1.4%" },
      ]),
    },
  },
  {
    id: "table.scenario.single-row",
    title: "Single row",
    presentation: { kind: "scenario", scenario: "single row" },
    props: {
      children: createTableRows([
        { path: "/pricing", views: "842", change: "+3.1%" },
      ]),
    },
  },
] as const satisfies readonly ComponentFixture<TableProps>[];

export const tableContract = defineComponentContract<TableProps>({
  id: "table",
  title: "Table",
  category: "Data display",
  categoryId: "data-display",
  description:
    "Semantic table structure using the production table primitives.",
  fixtures: tableFixtures,
  render: (props) => <Table {...props} />,
});
