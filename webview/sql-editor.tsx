import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, syntaxHighlighting, indentOnInput } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { sql, SQLite, PostgreSQL, MySQL, MariaSQL, MSSQL } from '@codemirror/lang-sql';
import type { DatabaseKind, DbObject, TableDetail } from '../src/database/types';

const sqlHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--sql-keyword)' },
  { tag: tags.string, color: 'var(--sql-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--sql-number)' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--sql-type)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.invalid, color: 'var(--sql-error)' },
]);

export interface SqlEditorHandle {
  selected(): string;
  focus(): void;
}
export const SqlEditor = forwardRef<
  SqlEditorHandle,
  {
    value: string;
    kind: DatabaseKind;
    objects: DbObject[];
    detail?: TableDetail;
    onChange(value: string): void;
    onRun(): void;
  }
>((props, ref) => {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    current = useRef(props);
  const language = useRef(new Compartment());
  current.current = props;
  useImperativeHandle(
    ref,
    () => ({
      selected: () => {
        const state = view.current?.state;
        return state
          ? state.sliceDoc(state.selection.main.from, state.selection.main.to) || state.doc.toString()
          : current.current.value;
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );
  const dialect = { sqlite: SQLite, postgres: PostgreSQL, mysql: MySQL, mariadb: MariaSQL, mssql: MSSQL };
  const extension = () =>
    sql({
      dialect: dialect[props.kind],
      schema: Object.fromEntries(
        props.objects.map((o) => [
          o.name,
          o.name === props.detail?.object.name ? props.detail.columns.map((c) => c.name) : [],
        ]),
      ),
      upperCaseKeywords: true,
    });
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: current.current.value,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
            syntaxHighlighting(sqlHighlighting),
          highlightSelectionMatches(),
          language.current.of(extension()),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                current.current.onRun();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL 编辑器', spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) current.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '13px' },
            '.cm-scroller': { fontFamily: 'Consolas, "Microsoft YaHei", monospace', overflow: 'auto' },
            '.cm-content': { padding: '14px 0', minHeight: '100%' },
            '.cm-line': { paddingLeft: '12px' },
            '.cm-gutters': {
              backgroundColor: 'var(--surface-alt)',
              color: 'var(--muted)',
              borderRight: '1px solid var(--line)',
            },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)' },
            '.cm-cursor': { borderLeftColor: 'var(--text)' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
            '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--line)' },
            '.cm-panels': { backgroundColor: 'var(--surface-alt)', color: 'var(--text)' },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(extension()) });
  }, [props.kind, props.objects, props.detail]);
  useEffect(() => {
    const editor = view.current;
    if (editor && props.value !== editor.state.doc.toString())
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value } });
  }, [props.value]);
  return <div ref={host} className="sql-editor-host" />;
});
