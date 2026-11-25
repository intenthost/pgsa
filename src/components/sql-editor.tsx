"use client";

import { useEffect, useRef } from "react";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
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
  Prec,
  type Extension,
} from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { cn } from "@/lib/utils";

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onExecute?: (sql: string) => void;
  schema?: Record<string, readonly string[]>;
  readOnly?: boolean;
  className?: string;
  placeholder?: string;
}

const externalSyncAnnotation = Annotation.define<boolean>();

const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const placeholderCompartment = new Compartment();

const pgsaSqlTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#ffffff",
      color: "#09090b",
      fontFamily:
        "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "13px",
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
      minWidth: "40px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 10px 0 8px",
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
    ".cm-placeholder": {
      color: "#71717a",
      fontStyle: "italic",
    },
    ".cm-tooltip": {
      backgroundColor: "#ffffff",
      border: "1px solid #e4e4e7",
      borderRadius: "8px",
      boxShadow:
        "0 8px 20px -4px rgba(9, 9, 11, 0.08), 0 2px 6px -2px rgba(9, 9, 11, 0.04)",
      color: "#09090b",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "inherit",
      fontSize: "12px",
      maxHeight: "220px",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "4px 10px",
      display: "flex",
      alignItems: "center",
      gap: "6px",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "#f4f4f5",
      color: "#09090b",
    },
    ".cm-completionMatchedText": {
      color: "#09090b",
      fontWeight: "600",
      textDecoration: "none",
    },
    ".cm-completionDetail": {
      color: "#52525b",
      fontStyle: "normal",
      marginLeft: "auto",
      fontSize: "11px",
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

const pgsaSqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#2563eb", fontWeight: "600" },
  { tag: tags.typeName, color: "#0369a1" },
  { tag: tags.standard(tags.name), color: "#1d4ed8" },
  { tag: tags.operator, color: "#52525b" },
  { tag: tags.string, color: "#047857" },
  { tag: tags.special(tags.string), color: "#0369a1" },
  { tag: tags.number, color: "#b45309" },
  { tag: [tags.bool, tags.null], color: "#7c3aed", fontWeight: "500" },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: "#09090b" },
  { tag: tags.special(tags.name), color: "#0369a1" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#52525b",
    fontStyle: "italic",
  },
  {
    tag: [tags.punctuation, tags.paren, tags.brace, tags.squareBracket],
    color: "#52525b",
  },
  { tag: tags.invalid, color: "#dc2626", textDecoration: "underline wavy #dc2626" },
]);

function buildSqlExtension(schema?: Record<string, readonly string[]>): Extension {
  const hasPublicPrefix = schema
    ? Object.keys(schema).some((key) => key.startsWith("public."))
    : false;

  return sql({
    dialect: PostgreSQL,
    schema,
    defaultSchema: hasPublicPrefix ? "public" : undefined,
    upperCaseKeywords: true,
  });
}

function buildReadOnlyExtension(readOnly: boolean): Extension {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    ...(readOnly ? [EditorView.contentAttributes.of({ tabindex: "0" })] : []),
  ];
}

function areSchemasEqual(
  a?: Record<string, readonly string[]>,
  b?: Record<string, readonly string[]>
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    const colsA = a[key];
    const colsB = b[key];
    if (!colsB || colsA.length !== colsB.length) return false;
    for (let i = 0; i < colsA.length; i += 1) {
      if (colsA[i] !== colsB[i]) return false;
    }
  }
  return true;
}

export function SqlEditor({
  value,
  onChange,
  onExecute,
  schema,
  readOnly = false,
  className,
  placeholder,
}: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const onChangeRef = useRef(onChange);
  const onExecuteRef = useRef(onExecute);
  const initialPropsRef = useRef({ value, schema, readOnly, placeholder });

  const lastSchemaRef = useRef<Record<string, readonly string[]> | undefined>(undefined);
  const lastReadOnlyRef = useRef<boolean | undefined>(undefined);
  const lastPlaceholderRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    onChangeRef.current = onChange;
    onExecuteRef.current = onExecute;
  }, [onChange, onExecute]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const initial = initialPropsRef.current;
    lastSchemaRef.current = initial.schema;
    lastReadOnlyRef.current = initial.readOnly;
    lastPlaceholderRef.current = initial.placeholder;

    const runExecute = (view: EditorView): boolean => {
      if (!onExecuteRef.current) return false;
      onExecuteRef.current(view.state.doc.toString());
      return true;
    };

    const state = EditorState.create({
      doc: initial.value.replace(/\r\n?/g, "\n"),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        codeFolding(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(pgsaSqlHighlightStyle),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        pgsaSqlTheme,
        languageCompartment.of(buildSqlExtension(initial.schema)),
        readOnlyCompartment.of(buildReadOnlyExtension(initial.readOnly)),
        placeholderCompartment.of(
          initial.placeholder ? cmPlaceholder(initial.placeholder) : []
        ),
        Prec.highest(
          keymap.of([
            { key: "Mod-Enter", run: runExecute },
            { key: "Ctrl-Enter", run: runExecute },
          ])
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((tr) =>
              tr.annotation(externalSyncAnnotation)
            )
          ) {
            onChangeRef.current(update.state.doc.toString());
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

    const normalized = value.replace(/\r\n?/g, "\n");
    const currentDoc = view.state.doc.toString();
    if (currentDoc === normalized) return;

    const mainSelection = view.state.selection.main;
    const clampedAnchor = Math.min(mainSelection.anchor, normalized.length);
    const clampedHead = Math.min(mainSelection.head, normalized.length);

    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: normalized,
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
    if (areSchemasEqual(lastSchemaRef.current, schema)) return;

    lastSchemaRef.current = schema;
    view.dispatch({
      effects: languageCompartment.reconfigure(buildSqlExtension(schema)),
    });
  }, [schema]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (lastReadOnlyRef.current === readOnly) return;

    lastReadOnlyRef.current = readOnly;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(buildReadOnlyExtension(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (lastPlaceholderRef.current === placeholder) return;

    lastPlaceholderRef.current = placeholder;
    view.dispatch({
      effects: placeholderCompartment.reconfigure(
        placeholder ? cmPlaceholder(placeholder) : []
      ),
    });
  }, [placeholder]);

  return (
    <div
      ref={containerRef}
      data-slot="sql-editor"
      data-readonly={readOnly ? "true" : undefined}
      className={cn(
        "relative overflow-hidden rounded-md border border-zinc-200 bg-white font-mono text-sm focus-within:border-zinc-400 focus-within:ring-1 focus-within:ring-zinc-300",
        className
      )}
    />
  );
}

export default SqlEditor;
