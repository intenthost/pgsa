"use client";

import { useEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { cn } from "@/lib/utils";

export interface JsonbViewerProps {
  value: unknown;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  className?: string;
}

const externalSyncAnnotation = Annotation.define<boolean>();
const readOnlyCompartment = new Compartment();

/**
 * Pretty-prints JSONB objects, primitives, or serialized JSON strings.
 * Falls back gracefully for non-JSON strings or unserializable values.
 */
export function formatJsonb(input: unknown): string {
  if (input === undefined) return "";
  if (input === null) return "null";

  if (typeof input === "string") {
    if (input.trim() === "") return "";
    try {
      const parsed: unknown = JSON.parse(input);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return input.replace(/\r\n?/g, "\n");
    }
  }

  if (typeof input === "bigint") {
    return input.toString();
  }

  try {
    const serialized = JSON.stringify(
      input,
      (_key, val: unknown) => (typeof val === "bigint" ? val.toString() : val),
      2
    );
    return serialized ?? String(input);
  } catch {
    return String(input);
  }
}

const pgsaJsonTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#ffffff",
      color: "#09090b",
      fontFamily:
        "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "12.5px",
      height: "100%",
      borderRadius: "inherit",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "inherit",
      lineHeight: "1.6",
    },
    ".cm-content": {
      padding: "10px 0",
      caretColor: "#18181b",
    },
    ".cm-line": {
      padding: "0 8px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#18181b",
      borderLeftWidth: "1.5px",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "rgba(24, 24, 27, 0.08)",
      },
    ".cm-activeLine": {
      backgroundColor: "#fafafa",
    },
    ".cm-gutters": {
      backgroundColor: "#fafafa",
      color: "#52525b",
      borderRight: "1px solid #e4e4e7",
      userSelect: "none",
      minWidth: "38px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px",
      fontSize: "11px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#f4f4f5",
      color: "#18181b",
    },
    ".cm-foldGutter .cm-gutterElement": {
      padding: "0 4px",
      color: "#52525b",
      cursor: "pointer",
    },
    ".cm-foldGutter .cm-gutterElement:hover": {
      color: "#18181b",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#f4f4f5",
      border: "1px solid #e4e4e7",
      color: "#52525b",
      borderRadius: "4px",
      padding: "0 5px",
      margin: "0 3px",
    },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(24, 24, 27, 0.08)",
      outline: "1px solid rgba(24, 24, 27, 0.25)",
      borderRadius: "2px",
    },
    "&.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "rgba(220, 38, 38, 0.1)",
      outline: "1px solid rgba(220, 38, 38, 0.35)",
      borderRadius: "2px",
    },
    ".cm-selectionMatch": {
      backgroundColor: "rgba(24, 24, 27, 0.07)",
      borderRadius: "2px",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(250, 204, 21, 0.28)",
      outline: "1px solid rgba(217, 119, 6, 0.45)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(24, 24, 27, 0.14)",
      outline: "1px solid #18181b",
    },
    ".cm-panels": {
      backgroundColor: "#fafafa",
      color: "#09090b",
      borderColor: "#e4e4e7",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid #e4e4e7",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid #e4e4e7",
    },
    ".cm-search": {
      fontSize: "12px",
      padding: "6px 10px",
      gap: "6px",
    },
    ".cm-search label": {
      color: "#52525b",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
    },
    ".cm-textfield": {
      backgroundColor: "#ffffff",
      color: "#09090b",
      border: "1px solid #e4e4e7",
      borderRadius: "4px",
      padding: "2px 6px",
    },
    ".cm-textfield:focus": {
      outline: "none",
      borderColor: "#71717a",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "#ffffff",
      color: "#18181b",
      border: "1px solid #e4e4e7",
      borderRadius: "4px",
      padding: "2px 8px",
      cursor: "pointer",
    },
    ".cm-button:hover": {
      backgroundColor: "#f4f4f5",
      borderColor: "#d4d4d8",
    },
    ".cm-panel.cm-search [name=close]": {
      color: "#52525b",
      cursor: "pointer",
    },
  },
  { dark: false }
);

const pgsaJsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "#0369a1" },
  { tag: tags.string, color: "#047857" },
  { tag: tags.number, color: "#b45309" },
  { tag: tags.bool, color: "#7c3aed", fontWeight: "500" },
  { tag: tags.null, color: "#7c3aed", fontStyle: "italic" },
  {
    tag: [
      tags.brace,
      tags.squareBracket,
      tags.separator,
      tags.punctuation,
    ],
    color: "#52525b",
  },
  { tag: tags.invalid, color: "#dc2626", textDecoration: "underline wavy #dc2626" },
]);

function buildReadOnlyExtension(readOnly: boolean): Extension {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    ...(readOnly ? [EditorView.contentAttributes.of({ tabindex: "0" })] : []),
  ];
}

export function JsonbViewer({
  value,
  onChange,
  readOnly,
  className,
}: JsonbViewerProps) {
  const effectiveReadOnly = readOnly ?? !onChange;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const onChangeRef = useRef(onChange);
  const initialPropsRef = useRef({
    value,
    effectiveReadOnly,
  });

  const lastPropValueRef = useRef<unknown>(undefined);
  const lastReadOnlyRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const initial = initialPropsRef.current;
    lastPropValueRef.current = initial.value;
    lastReadOnlyRef.current = initial.effectiveReadOnly;

    const state = EditorState.create({
      doc: formatJsonb(initial.value),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        codeFolding(),
        drawSelection(),
        indentUnit.of("  "),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorView.lineWrapping,
        json(),
        syntaxHighlighting(pgsaJsonHighlightStyle),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        pgsaJsonTheme,
        readOnlyCompartment.of(
          buildReadOnlyExtension(initial.effectiveReadOnly)
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((tr) =>
              tr.annotation(externalSyncAnnotation)
            )
          ) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: host,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (Object.is(lastPropValueRef.current, value)) return;
    lastPropValueRef.current = value;

    const currentDoc = view.state.doc.toString();
    if (
      typeof value === "string" &&
      value.replace(/\r\n?/g, "\n") === currentDoc
    ) {
      return;
    }

    const formatted = formatJsonb(value);
    if (formatted === currentDoc) return;

    const mainSelection = view.state.selection.main;
    const clampedAnchor = Math.min(mainSelection.anchor, formatted.length);
    const clampedHead = Math.min(mainSelection.head, formatted.length);

    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: formatted,
      },
      selection: {
        anchor: clampedAnchor,
        head: clampedHead,
      },
      annotations: externalSyncAnnotation.of(true),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (lastReadOnlyRef.current === effectiveReadOnly) return;

    lastReadOnlyRef.current = effectiveReadOnly;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(
        buildReadOnlyExtension(effectiveReadOnly)
      ),
    });
  }, [effectiveReadOnly]);

  return (
    <div
      ref={containerRef}
      data-slot="jsonb-viewer"
      data-readonly={effectiveReadOnly ? "true" : undefined}
      className={cn(
        "relative overflow-hidden rounded-md border border-zinc-200 bg-white font-mono text-sm focus-within:border-zinc-400 focus-within:ring-1 focus-within:ring-zinc-300",
        className
      )}
    />
  );
}

export default JsonbViewer;
