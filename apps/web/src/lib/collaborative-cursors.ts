import * as Y from 'yjs';
import type * as Monaco from 'monaco-editor';
import { Collaboration, type Presence } from './collaboration';

export const cursorColors = ['#82c9ff', '#e9a0ed', '#ffd080', '#8be0b1', '#ff9d9d', '#b9a5ff', '#80dddd', '#e3dc87'];
export function attachCursors(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, session: Collaboration, roster: (entries: Presence[]) => void) {
  const model = editor.getModel()!;
  const text = session.doc.getText('code');
  const decorations = editor.createDecorationsCollection();
  const widgets = new Map<string, Monaco.editor.IContentWidget>();
  let rosterKey = '';
  function render() {
    const entries = session.presence;
    const value = text.toString();
    // Monaco can display LF snapshots with CRLF model offsets on Windows.
    // Convert via line/column so presence never assumes identical EOL widths.
    const positionAt = (index: number) => {
      const before = value.slice(0, index);
      const lines = before.split('\n');
      return model.validatePosition({ lineNumber: lines.length, column: lines[lines.length - 1].length + 1 });
    };
    const key = JSON.stringify(entries.map(({ connectionId, userId, username, color }) => ({ connectionId, userId, username, color })));
    if (key !== rosterKey) { rosterKey = key; roster(entries); }
    for (const widget of widgets.values()) editor.removeContentWidget(widget);
    widgets.clear();
    const next: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const entry of entries) {
      if (entry.connectionId === session.socket.id || !entry.selection) continue;
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(entry.selection.anchor), session.doc);
      const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(entry.selection.head), session.doc);
      if (!anchor || !head || anchor.type !== text || head.type !== text) continue;
      const start = positionAt(Math.min(anchor.index, head.index));
      const end = positionAt(Math.max(anchor.index, head.index));
      const cursor = positionAt(head.index);
      const color = Number.isInteger(entry.color) && entry.color >= 0 && entry.color < cursorColors.length ? entry.color : 0;
      next.push({ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), options: { className: `remote-selection remote-color-${color}`, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } });
      next.push({ range: new monaco.Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column), options: { beforeContentClassName: `remote-cursor remote-color-${color}` } });
      const node = document.createElement('span');
      node.className = `remote-cursor-label remote-color-${color}`;
      node.textContent = entry.username;
      const widget: Monaco.editor.IContentWidget = {
        getId: () => `remote-cursor-${entry.connectionId}`, getDomNode: () => node,
        getPosition: () => ({ position: cursor, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW] }),
      };
      widgets.set(entry.connectionId, widget); editor.addContentWidget(widget);
    }
    decorations.set(next);
  }
  function publish() {
    const selection = editor.getSelection();
    if (!selection || !editor.hasTextFocus()) { session.setSelection(null); return; }
    const lines = text.toString().split('\n');
    const relative = (lineNumber: number, column: number) => {
      let offset = 0;
      for (let line = 0; line < lineNumber - 1; line++) offset += lines[line].length + 1;
      return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, offset + column - 1));
    };
    session.setSelection({ anchor: relative(selection.selectionStartLineNumber, selection.selectionStartColumn), head: relative(selection.positionLineNumber, selection.positionColumn) });
  }
  const listeners = [editor.onDidChangeCursorSelection(publish), editor.onDidFocusEditorText(publish), editor.onDidBlurEditorText(() => session.setSelection(null))];
  const unsubscribe = session.onPresence(render);
  session.doc.on('afterTransaction', render);
  render(); publish();
  return () => {
    listeners.forEach(listener => listener.dispose()); unsubscribe(); session.doc.off('afterTransaction', render);
    decorations.clear(); for (const widget of widgets.values()) editor.removeContentWidget(widget); widgets.clear();
  };
}
