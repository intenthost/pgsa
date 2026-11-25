"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  HierarchyIcon,
  Key01Icon,
  Link01Icon,
  Loading03Icon,
  RefreshIcon,
  Remove01Icon,
  Search01Icon,
  Table01Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { getSchemaGraphAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  ForeignKeyEdge,
  SchemaGraph,
  SchemaGraphResult,
  TableNode,
} from "@/types/postgres";

export interface SchemaVisualizerViewProps {
  initialGraph?: SchemaGraphResult | null;
  onOpenTable: (schema: string, table: string) => void;
}

interface Point {
  x: number;
  y: number;
}

interface RenderedEdge {
  key: string;
  edge: ForeignKeyEdge;
  sourceKey: string;
  targetKey: string;
  sourceColumn: string;
  targetColumn: string;
  path: string;
  startPoint: Point;
  isSelfRef: boolean;
}

const ALL_SCHEMAS_VALUE = "__all_schemas__";
const CARD_WIDTH = 248;
const CARD_BORDER_Y = 1;
const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 24;
const COLLAPSED_COLUMN_LIMIT = 12;
const COLLAPSE_THRESHOLD = 13;
const CANVAS_PADDING = 48;
const LAYER_GAP_X = 108;
const NODE_GAP_Y = 32;
const COMPONENT_GAP_X = 88;
const COMPONENT_GAP_Y = 64;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.15;

function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function edgeKey(edge: ForeignKeyEdge, index: number): string {
  return `${edge.sourceSchema}.${edge.sourceTable}.${edge.constraintName}#${index}`;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function formatRowEstimate(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(count));
}

function getVisibleColumns(
  table: TableNode,
  isExpanded: boolean
): {
  visibleColumns: TableNode["columns"];
  hiddenCount: number;
  hasOverflow: boolean;
} {
  if (isExpanded || table.columns.length <= COLLAPSE_THRESHOLD) {
    return {
      visibleColumns: table.columns,
      hiddenCount: 0,
      hasOverflow: false,
    };
  }
  return {
    visibleColumns: table.columns.slice(0, COLLAPSED_COLUMN_LIMIT),
    hiddenCount: table.columns.length - COLLAPSED_COLUMN_LIMIT,
    hasOverflow: true,
  };
}

function getCardHeight(table: TableNode, isExpanded: boolean): number {
  const { visibleColumns } = getVisibleColumns(table, isExpanded);
  const bodyRows = visibleColumns.length === 0 ? 1 : visibleColumns.length;
  const footerRows = table.columns.length > COLLAPSE_THRESHOLD ? 1 : 0;
  return CARD_BORDER_Y * 2 + HEADER_HEIGHT + (bodyRows + footerRows) * ROW_HEIGHT;
}

function getColumnCenterY(
  table: TableNode,
  columnName: string,
  isExpanded: boolean
): number {
  const { visibleColumns, hasOverflow } = getVisibleColumns(table, isExpanded);
  const index = visibleColumns.findIndex((col) => col.name === columnName);
  if (index >= 0) {
    return CARD_BORDER_Y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
  }
  if (hasOverflow) {
    return (
      CARD_BORDER_Y +
      HEADER_HEIGHT +
      visibleColumns.length * ROW_HEIGHT +
      ROW_HEIGHT / 2
    );
  }
  return CARD_BORDER_Y + HEADER_HEIGHT / 2;
}

/**
 * Computes a deterministic, overlap-free layout grouping connected components
 * into topological left-to-right layers (referenced parent tables on the left,
 * referencing child tables on the right) followed by isolated tables in a grid.
 */
function computeAutoLayout(
  tables: TableNode[],
  edges: ForeignKeyEdge[],
  expandedMap: Record<string, boolean>
): Record<string, Point> {
  const positions: Record<string, Point> = {};
  if (tables.length === 0) return positions;

  const tableMap = new Map<string, TableNode>();
  const heightMap = new Map<string, number>();
  for (const t of tables) {
    const key = tableKey(t.schema, t.name);
    tableMap.set(key, t);
    heightMap.set(key, getCardHeight(t, Boolean(expandedMap[key])));
  }

  const undirected = new Map<string, Set<string>>();
  const parentsOf = new Map<string, Set<string>>();
  const childrenOf = new Map<string, Set<string>>();
  const incomingRefCount = new Map<string, number>();

  for (const key of tableMap.keys()) {
    undirected.set(key, new Set());
    parentsOf.set(key, new Set());
    childrenOf.set(key, new Set());
    incomingRefCount.set(key, 0);
  }

  for (const edge of edges) {
    const src = tableKey(edge.sourceSchema, edge.sourceTable);
    const tgt = tableKey(edge.targetSchema, edge.targetTable);
    if (!tableMap.has(src) || !tableMap.has(tgt) || src === tgt) continue;

    undirected.get(src)?.add(tgt);
    undirected.get(tgt)?.add(src);
    // Target is referenced (parent), source holds the FK (child).
    parentsOf.get(src)?.add(tgt);
    childrenOf.get(tgt)?.add(src);
    incomingRefCount.set(tgt, (incomingRefCount.get(tgt) ?? 0) + 1);
  }

  const visited = new Set<string>();
  const connectedComponents: string[][] = [];
  const isolated: string[] = [];

  for (const t of tables) {
    const start = tableKey(t.schema, t.name);
    if (visited.has(start)) continue;

    const neighbors = undirected.get(start);
    if (!neighbors || neighbors.size === 0) {
      visited.add(start);
      isolated.push(start);
      continue;
    }

    const comp: string[] = [];
    const queue: string[] = [start];
    visited.add(start);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      comp.push(curr);
      for (const next of undirected.get(curr) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    connectedComponents.push(comp);
  }

  connectedComponents.sort((a, b) => b.length - a.length);

  interface PlacedComponent {
    width: number;
    height: number;
    localPositions: Map<string, Point>;
  }

  const placedComponents: PlacedComponent[] = [];

  for (const comp of connectedComponents) {
    const compSet = new Set(comp);
    // Order nodes so heavily referenced root entities come first for cycle breaking.
    const ordered = [...comp].sort((a, b) => {
      const scoreA =
        (incomingRefCount.get(a) ?? 0) - (parentsOf.get(a)?.size ?? 0);
      const scoreB =
        (incomingRefCount.get(b) ?? 0) - (parentsOf.get(b)?.size ?? 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.localeCompare(b);
    });

    // Break cycles greedily using DFS order.
    const dfsState = new Map<string, 0 | 1 | 2>();
    const dagParents = new Map<string, string[]>();
    for (const id of ordered) {
      dfsState.set(id, 0);
      dagParents.set(id, []);
    }

    const visit = (node: string) => {
      dfsState.set(node, 1);
      const children = [...(childrenOf.get(node) ?? [])].filter((c) =>
        compSet.has(c)
      );
      children.sort();
      for (const child of children) {
        const state = dfsState.get(child) ?? 0;
        if (state === 0) {
          dagParents.get(child)?.push(node);
          visit(child);
        } else if (state === 2) {
          dagParents.get(child)?.push(node);
        }
        // If state === 1, skip back-edge to keep acyclic layering.
      }
      dfsState.set(node, 2);
    };

    for (const id of ordered) {
      if (dfsState.get(id) === 0) {
        visit(id);
      }
    }

    const layerOf = new Map<string, number>();
    const getLayer = (node: string): number => {
      const cached = layerOf.get(node);
      if (cached !== undefined) return cached;
      const parents = dagParents.get(node) ?? [];
      let maxParent = -1;
      for (const p of parents) {
        maxParent = Math.max(maxParent, getLayer(p));
      }
      const layer = maxParent + 1;
      layerOf.set(node, layer);
      return layer;
    };

    for (const id of ordered) {
      getLayer(id);
    }

    // Group into layers and split oversized columns cleanly (> 5 cards per layer).
    const rawLayers = new Map<number, string[]>();
    for (const id of ordered) {
      const l = layerOf.get(id) ?? 0;
      const bucket = rawLayers.get(l) ?? [];
      bucket.push(id);
      rawLayers.set(l, bucket);
    }

    const sortedLayerIndices = [...rawLayers.keys()].sort((a, b) => a - b);
    const layerColumns: string[][] = [];

    for (let idx = 0; idx < sortedLayerIndices.length; idx++) {
      const nodes = rawLayers.get(sortedLayerIndices[idx]) ?? [];
      if (idx > 0 && layerColumns.length > 0) {
        const prevCol = layerColumns[layerColumns.length - 1];
        const prevIndex = new Map(prevCol.map((n, i) => [n, i]));
        nodes.sort((a, b) => {
          const bary = (node: string) => {
            const linked = [...(undirected.get(node) ?? [])].filter((p) =>
              prevIndex.has(p)
            );
            if (linked.length === 0) return Number.MAX_SAFE_INTEGER;
            const sum = linked.reduce((acc, p) => acc + (prevIndex.get(p) ?? 0), 0);
            return sum / linked.length;
          };
          const ba = bary(a);
          const bb = bary(b);
          if (ba !== bb) return ba - bb;
          return a.localeCompare(b);
        });
      } else {
        nodes.sort((a, b) => {
          const degDiff =
            (undirected.get(b)?.size ?? 0) - (undirected.get(a)?.size ?? 0);
          if (degDiff !== 0) return degDiff;
          return a.localeCompare(b);
        });
      }

      const maxPerColumn = 5;
      for (let start = 0; start < nodes.length; start += maxPerColumn) {
        layerColumns.push(nodes.slice(start, start + maxPerColumn));
      }
    }

    const colHeights = layerColumns.map((col) => {
      const totalCards = col.reduce(
        (sum, id) => sum + (heightMap.get(id) ?? 120),
        0
      );
      return totalCards + Math.max(0, col.length - 1) * NODE_GAP_Y;
    });
    const maxColHeight = Math.max(...colHeights, 0);

    const localPositions = new Map<string, Point>();
    layerColumns.forEach((col, colIdx) => {
      const x = colIdx * (CARD_WIDTH + LAYER_GAP_X);
      const colHeight = colHeights[colIdx];
      let y = Math.round((maxColHeight - colHeight) / 2);
      for (const id of col) {
        localPositions.set(id, { x, y });
        y += (heightMap.get(id) ?? 120) + NODE_GAP_Y;
      }
    });

    const width =
      layerColumns.length * CARD_WIDTH +
      Math.max(0, layerColumns.length - 1) * LAYER_GAP_X;

    placedComponents.push({
      width,
      height: maxColHeight,
      localPositions,
    });
  }

  // Pack connected components onto clean horizontal shelves.
  const targetShelfWidth = Math.max(1320, Math.ceil(Math.sqrt(tables.length)) * 380);
  let cursorX = CANVAS_PADDING;
  let cursorY = CANVAS_PADDING;
  let shelfHeight = 0;

  for (const comp of placedComponents) {
    if (
      cursorX > CANVAS_PADDING &&
      cursorX + comp.width > targetShelfWidth + CANVAS_PADDING
    ) {
      cursorX = CANVAS_PADDING;
      cursorY += shelfHeight + COMPONENT_GAP_Y;
      shelfHeight = 0;
    }

    for (const [id, pt] of comp.localPositions.entries()) {
      positions[id] = {
        x: cursorX + pt.x,
        y: cursorY + pt.y,
      };
    }

    cursorX += comp.width + COMPONENT_GAP_X;
    shelfHeight = Math.max(shelfHeight, comp.height);
  }

  // Pack isolated tables into a neat, height-aware grid below connected components.
  if (isolated.length > 0) {
    const startY =
      placedComponents.length > 0
        ? cursorY + shelfHeight + COMPONENT_GAP_Y
        : CANVAS_PADDING;
    const cols = Math.min(
      isolated.length,
      Math.max(3, Math.min(5, Math.ceil(Math.sqrt(isolated.length))))
    );
    const colY = new Array<number>(cols).fill(startY);

    for (let i = 0; i < isolated.length; i++) {
      // Pick the shortest column so mixed-height cards stay visually balanced.
      let bestCol = 0;
      for (let c = 1; c < cols; c++) {
        if (colY[c] < colY[bestCol]) bestCol = c;
      }
      const id = isolated[i];
      positions[id] = {
        x: CANVAS_PADDING + bestCol * (CARD_WIDTH + 48),
        y: colY[bestCol],
      };
      colY[bestCol] += (heightMap.get(id) ?? 120) + NODE_GAP_Y;
    }
  }

  return positions;
}

function buildEdgeGeometry(
  edge: ForeignKeyEdge,
  index: number,
  tableMap: Map<string, TableNode>,
  positions: Record<string, Point>,
  expandedMap: Record<string, boolean>
): RenderedEdge | null {
  const srcKey = tableKey(edge.sourceSchema, edge.sourceTable);
  const tgtKey = tableKey(edge.targetSchema, edge.targetTable);
  const srcTable = tableMap.get(srcKey);
  const tgtTable = tableMap.get(tgtKey);
  const srcPos = positions[srcKey];
  const tgtPos = positions[tgtKey];
  if (!srcTable || !tgtTable || !srcPos || !tgtPos) return null;

  const srcCol = edge.sourceColumns[0] ?? "";
  const tgtCol = edge.targetColumns[0] ?? "";
  const srcY =
    srcPos.y +
    getColumnCenterY(srcTable, srcCol, Boolean(expandedMap[srcKey]));
  const tgtY =
    tgtPos.y +
    getColumnCenterY(tgtTable, tgtCol, Boolean(expandedMap[tgtKey]));

  const isSelfRef = srcKey === tgtKey;
  if (isSelfRef) {
    const xEdge = srcPos.x + CARD_WIDTH;
    const loopX = xEdge + 68;
    const yDelta = Math.abs(tgtY - srcY);
    const spread = yDelta < 18 ? 22 : 0;
    const path = `M ${xEdge} ${srcY} C ${loopX} ${srcY - spread}, ${loopX} ${tgtY + spread}, ${xEdge} ${tgtY}`;
    return {
      key: edgeKey(edge, index),
      edge,
      sourceKey: srcKey,
      targetKey: tgtKey,
      sourceColumn: srcCol,
      targetColumn: tgtCol,
      path,
      startPoint: { x: xEdge, y: srcY },
      isSelfRef: true,
    };
  }

  const srcCenterX = srcPos.x + CARD_WIDTH / 2;
  const tgtCenterX = tgtPos.x + CARD_WIDTH / 2;
  const horizontalGap = Math.abs(tgtCenterX - srcCenterX);

  let x1: number;
  let x2: number;
  let c1x: number;
  let c2x: number;

  if (horizontalGap < CARD_WIDTH * 0.6) {
    // Vertically stacked cards: route cleanly down the right side without crossing card bodies.
    x1 = srcPos.x + CARD_WIDTH;
    x2 = tgtPos.x + CARD_WIDTH;
    const curveOut = Math.max(52, Math.min(110, Math.abs(tgtY - srcY) * 0.25 + 48));
    const maxEdgeX = Math.max(x1, x2);
    c1x = maxEdgeX + curveOut;
    c2x = maxEdgeX + curveOut;
  } else if (tgtCenterX >= srcCenterX) {
    x1 = srcPos.x + CARD_WIDTH;
    x2 = tgtPos.x;
    const dx = Math.max(48, Math.min(180, Math.abs(x2 - x1) * 0.5));
    c1x = x1 + dx;
    c2x = x2 - dx;
  } else {
    x1 = srcPos.x;
    x2 = tgtPos.x + CARD_WIDTH;
    const dx = Math.max(48, Math.min(180, Math.abs(x1 - x2) * 0.5));
    c1x = x1 - dx;
    c2x = x2 + dx;
  }

  const path = `M ${x1} ${srcY} C ${c1x} ${srcY}, ${c2x} ${tgtY}, ${x2} ${tgtY}`;
  return {
    key: edgeKey(edge, index),
    edge,
    sourceKey: srcKey,
    targetKey: tgtKey,
    sourceColumn: srcCol,
    targetColumn: tgtCol,
    path,
    startPoint: { x: x1, y: srcY },
    isSelfRef: false,
  };
}

export function SchemaVisualizerView({
  initialGraph,
  onOpenTable,
}: SchemaVisualizerViewProps) {
  const [graphResult, setGraphResult] = useState<SchemaGraphResult | null>(
    initialGraph ?? null
  );
  const [isLoading, setIsLoading] = useState<boolean>(!initialGraph);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const [selectedSchema, setSelectedSchema] =
    useState<string>(ALL_SCHEMAS_VALUE);
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>(
    {}
  );
  const [positions, setPositions] = useState<Record<string, Point>>(() =>
    initialGraph?.ok
      ? computeAutoLayout(initialGraph.graph.tables, initialGraph.graph.edges, {})
      : {}
  );
  const [hasCustomLayout, setHasCustomLayout] = useState<boolean>(false);

  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number>(1);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [draggingTableKey, setDraggingTableKey] = useState<string | null>(null);

  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
  const [hoveredTableKey, setHoveredTableKey] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originPanX: number;
    originPanY: number;
    moved: boolean;
  } | null>(null);
  const cardDragRef = useRef<{
    pointerId: number;
    key: string;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const zoomRef = useRef<number>(zoom);
  const panRef = useRef<Point>(pan);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const applyNewGraph = useCallback((result: SchemaGraphResult, resetLayout: boolean) => {
    setGraphResult(result);
    if (!result.ok) return;

    setPositions((prev) => {
      if (resetLayout || Object.keys(prev).length === 0) {
        return computeAutoLayout(result.graph.tables, result.graph.edges, {});
      }
      const next: Record<string, Point> = {};
      const missing: TableNode[] = [];
      for (const tbl of result.graph.tables) {
        const key = tableKey(tbl.schema, tbl.name);
        if (prev[key]) {
          next[key] = prev[key];
        } else {
          missing.push(tbl);
        }
      }
      if (missing.length > 0) {
        const auto = computeAutoLayout(
          result.graph.tables,
          result.graph.edges,
          {}
        );
        for (const tbl of missing) {
          const key = tableKey(tbl.schema, tbl.name);
          if (auto[key]) next[key] = auto[key];
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (initialGraph) return;
    let active = true;

    getSchemaGraphAction()
      .then((result) => {
        if (!active) return;
        applyNewGraph(result, true);
        setIsLoading(false);
      })
      .catch((error) => {
        if (!active) return;
        setGraphResult({
          ok: false,
          graph: { tables: [], edges: [], schemas: [] },
          error:
            error instanceof Error
              ? error.message
              : "Failed to load database schema graph.",
        });
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [initialGraph, applyNewGraph]);

  // Attach non-passive wheel listener for smooth trackpad pan and pinch/ctrl zoom around cursor.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        const currentZoom = zoomRef.current;
        const currentPan = panRef.current;
        const factor = Math.exp(-e.deltaY * 0.005);
        const nextZoom = clampZoom(currentZoom * factor);
        if (nextZoom === currentZoom) return;

        const worldX = (cursorX - currentPan.x) / currentZoom;
        const worldY = (cursorY - currentPan.y) / currentZoom;
        setZoom(nextZoom);
        setPan({
          x: cursorX - worldX * nextZoom,
          y: cursorY - worldY * nextZoom,
        });
      } else {
        setPan((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const graph: SchemaGraph = useMemo(
    () =>
      graphResult?.ok
        ? graphResult.graph
        : { tables: [], edges: [], schemas: [] },
    [graphResult]
  );

  const schemaItems = useMemo(() => {
    const uniqueSchemas = Array.from(new Set(graph.schemas));
    return [
      { label: "All schemas", value: ALL_SCHEMAS_VALUE },
      ...uniqueSchemas.map((s) => ({ label: s, value: s })),
    ];
  }, [graph.schemas]);

  const filterTablesAndEdges = useCallback(
    (schemaVal: string, queryVal: string, sourceGraph: SchemaGraph) => {
      const q = queryVal.trim().toLowerCase();
      const filteredTables = sourceGraph.tables.filter((t) => {
        if (schemaVal !== ALL_SCHEMAS_VALUE && t.schema !== schemaVal) {
          return false;
        }
        if (!q) return true;
        const fqn = tableKey(t.schema, t.name).toLowerCase();
        return t.name.toLowerCase().includes(q) || fqn.includes(q);
      });
      const visibleSet = new Set(
        filteredTables.map((t) => tableKey(t.schema, t.name))
      );
      const filteredEdges = sourceGraph.edges.filter((edge) => {
        const src = tableKey(edge.sourceSchema, edge.sourceTable);
        const tgt = tableKey(edge.targetSchema, edge.targetTable);
        return visibleSet.has(src) && visibleSet.has(tgt);
      });
      return { filteredTables, filteredEdges, visibleSet };
    },
    []
  );

  const { filteredTables: visibleTables, filteredEdges: visibleEdges } = useMemo(
    () => filterTablesAndEdges(selectedSchema, searchQuery, graph),
    [filterTablesAndEdges, selectedSchema, searchQuery, graph]
  );

  const visibleTableMap = useMemo(() => {
    const map = new Map<string, TableNode>();
    for (const t of visibleTables) {
      map.set(tableKey(t.schema, t.name), t);
    }
    return map;
  }, [visibleTables]);

  const renderedEdges = useMemo(() => {
    const list: RenderedEdge[] = [];
    visibleEdges.forEach((edge, idx) => {
      const geom = buildEdgeGeometry(
        edge,
        idx,
        visibleTableMap,
        positions,
        expandedTables
      );
      if (geom) list.push(geom);
    });
    return list;
  }, [visibleEdges, visibleTableMap, positions, expandedTables]);

  const activeTableKey = hoveredTableKey ?? selectedTableKey;
  const activeEdgeKey = hoveredEdgeKey ?? selectedEdgeKey;

  const activeRenderedEdge = useMemo(
    () =>
      activeEdgeKey
        ? renderedEdges.find((e) => e.key === activeEdgeKey) ?? null
        : null,
    [renderedEdges, activeEdgeKey]
  );

  const highlightedEdgeKeys = useMemo(() => {
    const set = new Set<string>();
    if (activeEdgeKey) {
      set.add(activeEdgeKey);
    }
    if (activeTableKey) {
      for (const re of renderedEdges) {
        if (re.sourceKey === activeTableKey || re.targetKey === activeTableKey) {
          set.add(re.key);
        }
      }
    }
    return set;
  }, [activeEdgeKey, activeTableKey, renderedEdges]);

  const highlightedTableKeys = useMemo(() => {
    const set = new Set<string>();
    if (activeTableKey) {
      set.add(activeTableKey);
      for (const re of renderedEdges) {
        if (re.sourceKey === activeTableKey) set.add(re.targetKey);
        if (re.targetKey === activeTableKey) set.add(re.sourceKey);
      }
    }
    if (activeRenderedEdge) {
      set.add(activeRenderedEdge.sourceKey);
      set.add(activeRenderedEdge.targetKey);
    }
    return set;
  }, [activeTableKey, activeRenderedEdge, renderedEdges]);

  const highlightedColumnKeys = useMemo(() => {
    const set = new Set<string>();
    for (const re of renderedEdges) {
      if (!highlightedEdgeKeys.has(re.key)) continue;
      for (const sc of re.edge.sourceColumns) {
        set.add(`${re.sourceKey}.${sc}`);
      }
      for (const tc of re.edge.targetColumns) {
        set.add(`${re.targetKey}.${tc}`);
      }
    }
    return set;
  }, [renderedEdges, highlightedEdgeKeys]);

  const activeTableEdges = useMemo(() => {
    if (!activeTableKey || activeRenderedEdge) return [];
    return renderedEdges.filter(
      (re) => re.sourceKey === activeTableKey || re.targetKey === activeTableKey
    );
  }, [activeTableKey, activeRenderedEdge, renderedEdges]);

  const hasAnyHighlight =
    highlightedEdgeKeys.size > 0 || highlightedTableKeys.size > 0;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const result = await getSchemaGraphAction();
      if (!result.ok) {
        if (graphResult?.ok) {
          toast.error(result.error ?? "Failed to refresh schema graph.");
        } else {
          setGraphResult(result);
        }
      } else {
        applyNewGraph(result, !hasCustomLayout);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to refresh schema graph.";
      if (graphResult?.ok) {
        toast.error(message);
      } else {
        setGraphResult({
          ok: false,
          graph: { tables: [], edges: [], schemas: [] },
          error: message,
        });
      }
    } finally {
      setIsRefreshing(false);
      setIsLoading(false);
    }
  };

  const handleAutoLayout = () => {
    const nextPositions = computeAutoLayout(
      visibleTables,
      visibleEdges,
      expandedTables
    );
    setPositions((prev) => ({ ...prev, ...nextPositions }));
    setHasCustomLayout(false);
    setPan({ x: 0, y: 0 });
  };

  const handleSchemaChange = (value: string | null) => {
    if (value === null) return;
    setSelectedSchema(value);
    setSelectedTableKey(null);
    setSelectedEdgeKey(null);
    if (!hasCustomLayout && graph.tables.length > 0) {
      const { filteredTables, filteredEdges } = filterTablesAndEdges(
        value,
        searchQuery,
        graph
      );
      const nextPositions = computeAutoLayout(
        filteredTables,
        filteredEdges,
        expandedTables
      );
      setPositions((prev) => ({ ...prev, ...nextPositions }));
      setPan({ x: 0, y: 0 });
    }
  };

  const zoomAroundCenter = (nextZoomRaw: number) => {
    const nextZoom = clampZoom(nextZoomRaw);
    const el = canvasRef.current;
    if (!el) {
      setZoom(nextZoom);
      return;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const worldX = (cx - pan.x) / zoom;
    const worldY = (cy - pan.y) / zoom;
    setZoom(nextZoom);
    setPan({
      x: cx - worldX * nextZoom,
      y: cy - worldY * nextZoom,
    });
  };

  const handleZoomIn = () => zoomAroundCenter(zoom + ZOOM_STEP);
  const handleZoomOut = () => zoomAroundCenter(zoom - ZOOM_STEP);
  const handleZoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (
      target.closest("[data-table-card]") ||
      target.closest("[data-edge-hit]") ||
      target.closest("[data-floating-bar]")
    ) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    panDragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originPanX: pan.x,
      originPanY: pan.y,
      moved: false,
    };
    setIsPanning(true);
  };

  const handleCanvasPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true;
    }
    setPan({
      x: drag.originPanX + dx,
      y: drag.originPanY + dy,
    });
  };

  const handleCanvasPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!drag.moved) {
      setSelectedTableKey(null);
      setSelectedEdgeKey(null);
    }
    panDragRef.current = null;
    setIsPanning(false);
  };

  const handleCardPointerDown = (
    e: ReactPointerEvent<HTMLElement>,
    key: string
  ) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;

    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const currentPos = positions[key] ?? { x: CANVAS_PADDING, y: CANVAS_PADDING };
    cardDragRef.current = {
      pointerId: e.pointerId,
      key,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originX: currentPos.x,
      originY: currentPos.y,
      moved: false,
    };
    setDraggingTableKey(key);
  };

  const handleCardPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = cardDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      drag.moved = true;
      setHasCustomLayout(true);
    }
    if (drag.moved) {
      setPositions((prev) => ({
        ...prev,
        [drag.key]: {
          x: Math.round(drag.originX + dx / zoom),
          y: Math.round(drag.originY + dy / zoom),
        },
      }));
    }
  };

  const handleCardPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = cardDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!drag.moved) {
      setSelectedEdgeKey(null);
      setSelectedTableKey((prev) => (prev === drag.key ? null : drag.key));
    }
    cardDragRef.current = null;
    setDraggingTableKey(null);
  };

  const toggleExpandTable = (key: string) => {
    setExpandedTables((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const isFiltered =
    selectedSchema !== ALL_SCHEMAS_VALUE || searchQuery.trim().length > 0;
  const showSchemaPrefix =
    selectedSchema === ALL_SCHEMAS_VALUE && graph.schemas.length > 1;

  const countsLabel = isFiltered
    ? `${visibleTables.length}/${graph.tables.length} ${
        graph.tables.length === 1 ? "table" : "tables"
      } · ${visibleEdges.length} ${
        visibleEdges.length === 1 ? "relation" : "relations"
      }`
    : `${graph.tables.length} ${
        graph.tables.length === 1 ? "table" : "tables"
      } · ${graph.edges.length} ${
        graph.edges.length === 1 ? "relation" : "relations"
      }`;

  const gridStep = Math.max(10, 20 * zoom);
  const zoomPercent = Math.round(zoom * 100);

  return (
    <TooltipProvider delay={250}>
      <div className="flex h-full w-full flex-col overflow-hidden bg-white">
        {/* Flush Top Canvas Bar */}
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Select
              items={schemaItems}
              value={selectedSchema}
              onValueChange={handleSchemaChange}
            >
              <SelectTrigger
                size="sm"
                className="min-w-32 bg-white text-xs"
                aria-label="Filter schema"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectGroup>
                  {schemaItems.map((item) => (
                    <SelectItem
                      key={item.value}
                      value={item.value}
                      className="text-xs"
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            <div className="relative flex items-center">
              <HugeiconsIcon
                icon={Search01Icon}
                size={13}
                strokeWidth={1.8}
                className="pointer-events-none absolute left-2 text-zinc-500"
              />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter nodes..."
                aria-label="Filter schema nodes"
                className="h-7 w-44 bg-white pr-6 pl-7 text-xs md:text-xs"
              />
              {searchQuery.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear filter"
                  className="absolute right-0.5 size-5 text-zinc-500 hover:text-zinc-800"
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              )}
            </div>

            <span className="hidden truncate text-xs text-zinc-600 tabular-nums sm:inline">
              {countsLabel}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleRefresh}
                    disabled={isLoading || isRefreshing}
                    aria-label="Refresh schema graph"
                  />
                }
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  strokeWidth={1.8}
                  className={cn((isLoading || isRefreshing) && "animate-spin")}
                />
              </TooltipTrigger>
              <TooltipContent side="bottom">Refresh schema</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAutoLayout}
                    disabled={visibleTables.length === 0}
                  />
                }
              >
                <HugeiconsIcon
                  icon={HierarchyIcon}
                  strokeWidth={1.8}
                  data-icon="inline-start"
                />
                Auto Layout
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Reset topological card layout
              </TooltipContent>
            </Tooltip>

            <Separator orientation="vertical" className="mx-1 h-4" />

            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleZoomOut}
                      disabled={zoom <= MIN_ZOOM}
                      aria-label="Zoom out"
                    />
                  }
                >
                  <HugeiconsIcon icon={Remove01Icon} strokeWidth={1.8} />
                </TooltipTrigger>
                <TooltipContent side="bottom">Zoom out</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleZoomReset}
                      className="min-w-12 px-1.5 text-xs tabular-nums"
                      aria-label="Reset zoom to 100%"
                    />
                  }
                >
                  {zoomPercent}%
                </TooltipTrigger>
                <TooltipContent side="bottom">Reset view (100%)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleZoomIn}
                      disabled={zoom >= MAX_ZOOM}
                      aria-label="Zoom in"
                    />
                  }
                >
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={1.8} />
                </TooltipTrigger>
                <TooltipContent side="bottom">Zoom in</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Architectural Light Dot-Grid Canvas */}
        <div
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          className={cn(
            "relative flex-1 overflow-hidden bg-[#fafafa] select-none",
            isPanning ? "cursor-grabbing" : "cursor-default"
          )}
          style={{
            backgroundImage: "radial-gradient(#e4e4e7 1px, transparent 1px)",
            backgroundSize: `${gridStep}px ${gridStep}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
          }}
        >
          {isLoading ? (
            <div className="flex h-full w-full items-center justify-center">
              <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 shadow-2xs">
                <HugeiconsIcon
                  icon={Loading03Icon}
                  size={14}
                  strokeWidth={2}
                  className="animate-spin text-zinc-600"
                />
                <span>Introspecting tables and foreign keys...</span>
              </div>
            </div>
          ) : graphResult && !graphResult.ok ? (
            <div className="flex h-full w-full items-center justify-center p-6">
              <div className="flex max-w-md flex-col items-center gap-3 rounded-md border border-zinc-200 bg-white p-5 text-center shadow-2xs">
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  size={20}
                  strokeWidth={1.8}
                  className="text-red-600"
                />
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-semibold text-zinc-900">
                    Unable to load schema graph
                  </p>
                  <p className="text-xs text-zinc-600">
                    {graphResult.error ??
                      "Check your database connection and try again."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    strokeWidth={1.8}
                    data-icon="inline-start"
                    className={cn(isRefreshing && "animate-spin")}
                  />
                  Retry
                </Button>
              </div>
            </div>
          ) : visibleTables.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center p-6">
              <div className="flex max-w-sm flex-col items-center gap-2.5 rounded-md border border-zinc-200 bg-white p-5 text-center shadow-2xs">
                <HugeiconsIcon
                  icon={Table01Icon}
                  size={20}
                  strokeWidth={1.8}
                  className="text-zinc-500"
                />
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-semibold text-zinc-900">
                    {graph.tables.length === 0
                      ? "No tables found"
                      : "No matching tables"}
                  </p>
                  <p className="text-xs text-zinc-600">
                    {graph.tables.length === 0
                      ? "This PostgreSQL database has no user tables or views to visualize yet."
                      : "Adjust your schema selection or filter query to see matching nodes."}
                  </p>
                </div>
                {isFiltered && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedSchema(ALL_SCHEMAS_VALUE);
                      setSearchQuery("");
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div
              className="pointer-events-none absolute top-0 left-0 origin-top-left"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              {/* SVG Foreign-Key Connector Layer */}
              <svg
                width={1}
                height={1}
                className="pointer-events-none absolute top-0 left-0 overflow-visible"
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="pgsa-fk-arrow-rest"
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3.5"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path d="M 0.5 1 L 6.5 3.5 L 0.5 6 z" fill="#b4b4bc" />
                  </marker>
                  <marker
                    id="pgsa-fk-arrow-active"
                    markerWidth="8"
                    markerHeight="8"
                    refX="6.5"
                    refY="4"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path d="M 0.5 1 L 7 4 L 0.5 7 z" fill="#18181b" />
                  </marker>
                </defs>

                {/* Render resting edges below highlighted edges */}
                {renderedEdges
                  .filter((re) => !highlightedEdgeKeys.has(re.key))
                  .map((re) => (
                    <g key={re.key} data-edge-hit="true">
                      <path
                        d={re.path}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                        className="pointer-events-auto cursor-pointer"
                        onMouseEnter={() => setHoveredEdgeKey(re.key)}
                        onMouseLeave={() =>
                          setHoveredEdgeKey((curr) =>
                            curr === re.key ? null : curr
                          )
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedTableKey(null);
                          setSelectedEdgeKey((curr) =>
                            curr === re.key ? null : re.key
                          );
                        }}
                      />
                      <path
                        d={re.path}
                        fill="none"
                        stroke="#d4d4d8"
                        strokeWidth={1.25}
                        opacity={hasAnyHighlight ? 0.45 : 1}
                        markerEnd="url(#pgsa-fk-arrow-rest)"
                        className="pointer-events-none"
                      />
                    </g>
                  ))}

                {renderedEdges
                  .filter((re) => highlightedEdgeKeys.has(re.key))
                  .map((re) => (
                    <g key={re.key} data-edge-hit="true">
                      <path
                        d={re.path}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                        className="pointer-events-auto cursor-pointer"
                        onMouseEnter={() => setHoveredEdgeKey(re.key)}
                        onMouseLeave={() =>
                          setHoveredEdgeKey((curr) =>
                            curr === re.key ? null : curr
                          )
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedTableKey(null);
                          setSelectedEdgeKey((curr) =>
                            curr === re.key ? null : re.key
                          );
                        }}
                      />
                      <path
                        d={re.path}
                        fill="none"
                        stroke="#18181b"
                        strokeWidth={1.75}
                        markerEnd="url(#pgsa-fk-arrow-active)"
                        className="pointer-events-none"
                      />
                      <circle
                        cx={re.startPoint.x}
                        cy={re.startPoint.y}
                        r={2.5}
                        fill="#18181b"
                        className="pointer-events-none"
                      />
                    </g>
                  ))}
              </svg>

              {/* Table Entity Cards */}
              {visibleTables.map((t) => {
                const key = tableKey(t.schema, t.name);
                const pos = positions[key] ?? {
                  x: CANVAS_PADDING,
                  y: CANVAS_PADDING,
                };
                const isExpanded = Boolean(expandedTables[key]);
                const { visibleColumns, hiddenCount, hasOverflow } =
                  getVisibleColumns(t, isExpanded);
                const isHighlighted = highlightedTableKeys.has(key);
                const isPrimaryActive =
                  activeTableKey === key || draggingTableKey === key;

                return (
                  <div
                    key={key}
                    data-table-card={key}
                    onMouseEnter={() => setHoveredTableKey(key)}
                    onMouseLeave={() =>
                      setHoveredTableKey((curr) => (curr === key ? null : curr))
                    }
                    onPointerDown={(e) => handleCardPointerDown(e, key)}
                    onPointerMove={handleCardPointerMove}
                    onPointerUp={handleCardPointerUp}
                    onPointerCancel={handleCardPointerUp}
                    className={cn(
                      "pointer-events-auto absolute w-[248px] rounded-md border bg-white shadow-2xs transition-[border-color,box-shadow] duration-100",
                      isHighlighted
                        ? "border-zinc-900"
                        : "border-zinc-200 hover:border-zinc-400",
                      isPrimaryActive && "z-10 ring-1 ring-zinc-900/10"
                    )}
                    style={{
                      transform: `translate(${pos.x}px, ${pos.y}px)`,
                    }}
                  >
                    {/* Card Header */}
                    <div
                      className={cn(
                        "flex h-8 cursor-grab items-center justify-between gap-1.5 rounded-t-[5px] border-b px-2.5 active:cursor-grabbing",
                        isHighlighted
                          ? "border-zinc-200 bg-zinc-100/80"
                          : "border-zinc-200 bg-zinc-50"
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          title={key}
                          className="truncate text-xs font-semibold text-zinc-900"
                        >
                          {(showSchemaPrefix || t.schema !== "public") && (
                            <span className="font-normal text-zinc-600">
                              {t.schema}.
                            </span>
                          )}
                          {t.name}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <span
                          title={`~${t.rowEstimate.toLocaleString()} estimated rows`}
                          className="font-mono text-[11px] text-zinc-600 tabular-nums"
                        >
                          {formatRowEstimate(t.rowEstimate)}
                        </span>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenTable(t.schema, t.name);
                                }}
                                aria-label={`Open ${key} in Tables`}
                                className="size-5 text-zinc-500 hover:text-zinc-900"
                              />
                            }
                          >
                            <HugeiconsIcon
                              icon={ArrowUpRight01Icon}
                              strokeWidth={2}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            Open table data
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    {/* Column Rows */}
                    <div className="flex flex-col">
                      {visibleColumns.length === 0 ? (
                        <div className="flex h-6 items-center px-2.5 text-[11px] text-zinc-600">
                          No columns
                        </div>
                      ) : (
                        visibleColumns.map((col) => {
                          const colHighlight = highlightedColumnKeys.has(
                            `${key}.${col.name}`
                          );
                          const colTooltip = [
                            `${col.name}: ${col.dataType}`,
                            col.nullable ? "NULL" : "NOT NULL",
                            col.isPrimaryKey ? "PRIMARY KEY" : null,
                            col.foreignTarget
                              ? `FK -> ${col.foreignTarget.schema}.${col.foreignTarget.table}.${col.foreignTarget.column}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ");

                          return (
                            <div
                              key={col.name}
                              title={colTooltip}
                              className={cn(
                                "flex h-6 items-center justify-between gap-2 border-b border-zinc-100 px-2.5 text-xs last:border-0",
                                colHighlight && "bg-zinc-100/80"
                              )}
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="flex w-3 shrink-0 items-center justify-center">
                                  {col.isPrimaryKey ? (
                                    <HugeiconsIcon
                                      icon={Key01Icon}
                                      size={12}
                                      strokeWidth={2}
                                      className="text-amber-600"
                                    />
                                  ) : col.isForeignKey ? (
                                    <HugeiconsIcon
                                      icon={Link01Icon}
                                      size={12}
                                      strokeWidth={2}
                                      className="text-sky-600"
                                    />
                                  ) : (
                                    <span className="size-1 rounded-full bg-zinc-400" />
                                  )}
                                </span>
                                {col.isPrimaryKey && col.isForeignKey && (
                                  <HugeiconsIcon
                                    icon={Link01Icon}
                                    size={11}
                                    strokeWidth={2}
                                    className="shrink-0 text-sky-600"
                                  />
                                )}
                                <span
                                  className={cn(
                                    "truncate text-zinc-800",
                                    (col.isPrimaryKey || col.isForeignKey) &&
                                      "font-medium text-zinc-900"
                                  )}
                                >
                                  {col.name}
                                </span>
                              </div>

                              <span className="max-w-[88px] shrink-0 truncate font-mono text-[11px] text-zinc-600">
                                {col.dataType}
                                {col.nullable ? "?" : ""}
                              </span>
                            </div>
                          );
                        })
                      )}

                      {(hasOverflow || isExpanded) &&
                        t.columns.length > COLLAPSE_THRESHOLD && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpandTable(key);
                            }}
                            className="flex h-6 w-full items-center justify-between border-t border-zinc-100 bg-zinc-50/70 px-2.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
                          >
                            <span>
                              {isExpanded
                                ? "Collapse columns"
                                : `Show ${hiddenCount} more columns`}
                            </span>
                            <HugeiconsIcon
                              icon={isExpanded ? ArrowUp01Icon : ArrowDown01Icon}
                              size={12}
                              strokeWidth={2}
                            />
                          </button>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Compact Floating Bottom-Left Edge Detail Bar */}
          {activeRenderedEdge ? (
            <div
              data-floating-bar="true"
              className="pointer-events-auto absolute bottom-3 left-3 flex max-w-[calc(100%-24px)] items-center gap-2 rounded-md border border-zinc-200 bg-white/95 px-2.5 py-1.5 text-xs shadow-xs backdrop-blur-xs"
            >
              <HugeiconsIcon
                icon={Link01Icon}
                size={13}
                strokeWidth={2}
                className="shrink-0 text-sky-600"
              />
              <span className="truncate font-mono text-[11px] font-medium text-zinc-900">
                {activeRenderedEdge.edge.constraintName}
              </span>
              <span className="text-zinc-500">·</span>
              <span className="truncate font-mono text-[11px] text-zinc-700">
                {activeRenderedEdge.edge.sourceTable}.
                {activeRenderedEdge.edge.sourceColumns.join(", ")}
                {" -> "}
                {activeRenderedEdge.edge.targetTable}.
                {activeRenderedEdge.edge.targetColumns.join(", ")}
              </span>
              <span className="text-zinc-500">·</span>
              <Badge
                variant="secondary"
                className="h-5 shrink-0 px-1.5 font-mono text-[11px] text-zinc-700"
              >
                ON DELETE {activeRenderedEdge.edge.onDelete}
              </Badge>
              {selectedEdgeKey === activeRenderedEdge.key && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setSelectedEdgeKey(null)}
                  aria-label="Clear edge selection"
                  className="size-5 text-zinc-500 hover:text-zinc-900"
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              )}
            </div>
          ) : (
            activeTableKey &&
            activeTableEdges.length > 0 && (
              <div
                data-floating-bar="true"
                className="pointer-events-auto absolute bottom-3 left-3 flex max-w-[calc(100%-24px)] flex-col gap-1 rounded-md border border-zinc-200 bg-white/95 px-2.5 py-1.5 text-xs shadow-xs backdrop-blur-xs"
              >
                {activeTableEdges.slice(0, 3).map((re) => (
                  <button
                    key={re.key}
                    type="button"
                    onClick={() => {
                      setSelectedTableKey(null);
                      setSelectedEdgeKey(re.key);
                    }}
                    className="flex items-center gap-2 text-left transition-colors hover:text-zinc-950"
                  >
                    <HugeiconsIcon
                      icon={Link01Icon}
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 text-sky-600"
                    />
                    <span className="truncate font-mono text-[11px] font-medium text-zinc-900">
                      {re.edge.constraintName}
                    </span>
                    <span className="text-zinc-500">·</span>
                    <span className="truncate font-mono text-[11px] text-zinc-700">
                      {re.edge.sourceTable}.{re.sourceColumn}
                      {" -> "}
                      {re.edge.targetTable}.{re.targetColumn}
                    </span>
                    <span className="text-zinc-500">·</span>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-600">
                      ON DELETE {re.edge.onDelete}
                    </span>
                  </button>
                ))}
                {activeTableEdges.length > 3 && (
                  <span className="pl-5 text-[11px] text-zinc-600 tabular-nums">
                    +{activeTableEdges.length - 3} more relation
                    {activeTableEdges.length - 3 === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
