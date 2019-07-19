import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette } from "@jupyterlab/apputils";
import { INotebookTracker } from "@jupyterlab/notebook";
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import { ISettingRegistry } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';

import { FileEditorJumper } from "./jumpers/fileeditor";
import { NotebookJumper } from "./jumpers/notebook";

import { CodeMirrorExtension } from "./editors/codemirror";
import { KeyModifier } from "./editors/editor";
import { JumpHistory } from "./history";

import 'codemirror/addon/hint/show-hint.css';
import 'codemirror/addon/hint/show-hint';

import 'lsp-editor-adapter/lib/codemirror-lsp.css';
import { LspWsConnection, CodeMirrorAdapter, IPosition } from 'lsp-editor-adapter';
import { IDocumentWidget } from "@jupyterlab/docregistry";
import { CodeEditor } from "@jupyterlab/codeeditor";


class CodeMirrorAdapterExtension extends CodeMirrorAdapter {

  public handleGoTo(locations: any) {
    // @ts-ignore
    this._removeTooltip();

    // do not handle GoTo actions here
  }

}


class FileEditorAdapter {

  editor: FileEditor;
  widget: IDocumentWidget;
  jumper: FileEditorJumper;
  adapter: CodeMirrorAdapterExtension;
  connection: LspWsConnection;
  app: JupyterFrontEnd;

  constructor(editor_widget: IDocumentWidget<FileEditor>, jumper: FileEditorJumper, app: JupyterFrontEnd) {
    this.widget = editor_widget;
    this.editor = editor_widget.content;

    this.app = app;
    // let root = PageConfig.getOption('serverRoot');
    let cm_editor = this.editor.editor as CodeMirrorEditor;
    // TODO: reconsider where language, path and cwd belong
    let value = jumper.language;

    this.connection = new LspWsConnection({
      serverUri: 'ws://localhost/' + value,
      languageId: value,
      // paths handling needs testing on Windows and with other language servers
      // PathExt.join(root, jumper.cwd)
      // PathExt.join(root, jumper.path)
      rootUri: 'file:///' + jumper.cwd,
      documentUri: 'file:///' + jumper.path,
      documentText: () => cm_editor.editor.getValue(),
    }).connect(new WebSocket('ws://localhost:3000/' + value));

    // @ts-ignore
    this.adapter = new CodeMirrorAdapterExtension(this.connection, {
      quickSuggestionsDelay: 10,
    }, cm_editor.editor);

    // detach the adapters contextmenu for now:
    // @ts-ignore
    this.adapter.editor.getWrapperElement().removeEventListener('contextmenu', this.adapter.editorListeners.contextmenu);
    // TODO: actually we only need the connection... the tooltips and suggestions will need re-writing to JL standards anyway

    // @ts-ignore
    this.connection.on('goTo', (locations) => {
      // TODO: implement selector for multiple locations

      let location = locations[0];

      // @ts-ignore
      let uri: string = location.uri;

      let current_uri = this.connection.getDocumentUri();

      // @ts-ignore
      let line = location.range.start.line;
      // @ts-ignore
      let column = location.range.start.character;

      if(uri == current_uri) {
        jumper.jump(
          jumper.getJumpPosition({line: line, column: column})
        );
        return;
      }

      if (uri.startsWith('file://'))
        uri = uri.slice(7);

      jumper.global_jump({
        uri: '.lsp_symlink/' + uri,
        editor_index: 0,
        line: line,
        column: column
      }, true);

    });

    console.log('Connected adapter');
  }

  get path() {
    return this.widget.context.path
  }

  get_doc_position_from_context_menu() : IPosition {
    // get the first node as it gives the most accurate approximation
    let leaf_node = this.app.contextMenuHitTest(() => true);

    let cm_editor = this.editor.editor as CodeMirrorEditor;
    let {left, top} = leaf_node.getBoundingClientRect();

    // @ts-ignore
    let event = this.app._contextMenuEvent;

    // if possible, use more accurate position from the actual event
    // (but this relies on an undocumented and unstable feature)
    if(event !== undefined) {
     left = event.clientX;
     top = event.clientY;
     event.stopPropagation()
    }
    return cm_editor.editor.coordsChar({
      left: left,
      top: top,
    }, 'window');
  }

}

const file_editor_adapters: Map<string, FileEditorAdapter> = new Map();
const file_jumpers: Map<string, FileEditorJumper> = new Map();


/**
 * The plugin registration information.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@krassowski/jupyterlab_go_to_definition:plugin',
  requires: [IEditorTracker, INotebookTracker, ISettingRegistry, ICommandPalette, IDocumentManager],
  activate: (
    app: JupyterFrontEnd,
    fileEditorTracker: IEditorTracker,
    notebookTracker: INotebookTracker,
    settingRegistry: ISettingRegistry,
    palette: ICommandPalette,
    documentManager: IDocumentManager
  ) => {

    let jump_history = new JumpHistory();

    CodeMirrorExtension.configure();

    fileEditorTracker.widgetUpdated.connect((sender, widget) => {
      console.log(sender)
      console.log(widget)
      // TODO?
      // adapter.remove();
      //connection.close();

    });

    fileEditorTracker.widgetAdded.connect((sender, widget) => {

      let fileEditor = widget.content;

      if (fileEditor.editor instanceof CodeMirrorEditor) {
        let jumper = new FileEditorJumper(widget, jump_history, documentManager);
        let extension = new CodeMirrorExtension(fileEditor.editor, jumper);
        file_jumpers.set(fileEditor.id, jumper);
        let adapter = new FileEditorAdapter(widget, jumper, app);
        file_editor_adapters.set(fileEditor.id, adapter);
        extension.connect();
      }
    });

    let file_editor_commands = [
      {
        'id': 'lsp_get_definition',
        'execute': (connection: LspWsConnection, position: IPosition) => connection.getDefinition(position),
        'isEnabled': (connection: LspWsConnection) => connection.isDefinitionSupported(),
        'label': 'Jump to definition',
      },
      {
        'id': 'lsp_get_type_definition',
        'execute': (connection: LspWsConnection, position: IPosition) => connection.getTypeDefinition(position),
        'isEnabled': (connection: LspWsConnection) => connection.isTypeDefinitionSupported(),
        'label': 'Highlight type definition',
      },
      {
        'id': 'lsp_get_references',
        'execute': (connection: LspWsConnection, position: IPosition) => connection.getReferences(position),
        'isEnabled': (connection: LspWsConnection) => connection.isReferencesSupported(),
        'label': 'Highlight references',
      }

    ];

    let is_context_menu_over_token = () => {
      let fileEditor = fileEditorTracker.currentWidget.content;
      let adapter = file_editor_adapters.get(fileEditor.id);
      let docPosition = adapter.get_doc_position_from_context_menu();
      if (!docPosition)
        return false;
      let ce_position: CodeEditor.IPosition = {line: docPosition.line, column: docPosition.ch};
      let token = adapter.editor.editor.getTokenForPosition(ce_position);
      return token.value !== '';
    };

    for(let cmd of file_editor_commands) {
      app.commands.addCommand(cmd.id, {
        execute: () => {
          let fileEditor = fileEditorTracker.currentWidget.content;
          let adapter = file_editor_adapters.get(fileEditor.id);
          let docPosition = adapter.get_doc_position_from_context_menu();
          cmd.execute(adapter.connection, docPosition);
        },
        isEnabled: () => {
          let fileEditor = fileEditorTracker.currentWidget.content;
          let adapter = file_editor_adapters.get(fileEditor.id);
          return adapter && adapter.connection && cmd.isEnabled(adapter.connection);
        },
        isVisible: is_context_menu_over_token,
        label: cmd.label
      });

      app.contextMenu.addItem({
        selector: '.jp-FileEditor',
        command: cmd.id
      });
    }

    notebookTracker.widgetAdded.connect((sender, widget) => {

      // btw: notebookTracker.currentWidget.content === notebook
      let jumper = new NotebookJumper(widget, jump_history, documentManager);
      let notebook = widget.content;

      // timeout ain't elegant but the widgets are not populated at the start-up time
      // (notebook.widgets.length === 1) - some time is needed for that,
      // and I can't see any callbacks for cells.

      // more insane idea would be to have it run once every 2 seconds
      // more reasonable thing would be to create a PR with .onAddCell
      setTimeout(() => {
        // now (notebook.widgets.length is likely > 1)
        notebook.widgets.every((cell) => {

          let codemirror_editor = cell.editor as CodeMirrorEditor;
          let extension = new CodeMirrorExtension(codemirror_editor, jumper);

          extension.connect();

          return true
        });
      }, 2000);

      // for that cells which will be added later:
      notebook.activeCellChanged.connect((notebook, cell) => {
        if(cell === undefined)
          return;

        let codemirror_editor = cell.editor as CodeMirrorEditor;
        let extension = new CodeMirrorExtension(codemirror_editor, jumper);

        extension.connect();
      });

    });

    function updateOptions(settings: ISettingRegistry.ISettings): void {
      let options = settings.composite;
      Object.keys(options).forEach((key) => {
        if (key === 'modifier') {
          let modifier = options[key] as KeyModifier;
          CodeMirrorExtension.modifierKey = modifier;
        }
      });
    }

    settingRegistry
      .load(plugin.id)
      .then(settings => {
        updateOptions(settings);
        settings.changed.connect(() => {
          updateOptions(settings);
        });
      })
      .catch((reason: Error) => {
        console.error(reason.message);
      });

    // Add an application command
    const cmdIds = {
      jumpNotebook: 'go-to-definition:notebook',
      jumpFileEditor: 'go-to-definition:file-editor',
      jumpBackNotebook: 'go-to-definition:notebook-back',
      jumpBackFileEditor: 'go-to-definition:file-editor-back',
    };

    // Add the command to the palette.
    palette.addItem({ command: cmdIds.jumpNotebook, category: 'Notebook Cell Operations' });
    palette.addItem({ command: cmdIds.jumpBackNotebook, category: 'Notebook Cell Operations' });
    palette.addItem({ command: cmdIds.jumpFileEditor, category: 'Text Editor' });
    palette.addItem({ command: cmdIds.jumpBackFileEditor, category: 'Text Editor' });

    function isEnabled(tracker: any) {
      return (): boolean =>
        tracker.currentWidget !== null
        &&
        tracker.currentWidget === app.shell.currentWidget
    }

    app.commands.addCommand(cmdIds.jumpNotebook, {
      label: 'Jump to definition',
      execute: () => {
        let notebook_widget = notebookTracker.currentWidget;
        let notebook = notebook_widget.content;

        let jumper = new NotebookJumper(notebook_widget, jump_history, documentManager);
        let cell = notebook_widget.content.activeCell;
        let editor = cell.editor;

        let position = editor.getCursorPosition();
        let token = editor.getTokenForPosition(position);

        jumper.jump_to_definition({token, origin: null}, notebook.activeCellIndex)
      },
      isEnabled: isEnabled(notebookTracker)
    });

    app.commands.addCommand(cmdIds.jumpBackNotebook, {
      label: 'Jump back',
      execute: () => {
        let notebook_widget = notebookTracker.currentWidget;

        let jumper = new NotebookJumper(notebook_widget, jump_history, documentManager);
        jumper.jump_back();
      },
      isEnabled: isEnabled(notebookTracker)
    });

    app.commands.addCommand(cmdIds.jumpFileEditor, {
      label: 'Jump to definition',
      execute: () => {
        let fileEditorWidget = fileEditorTracker.currentWidget;
        let fileEditor = fileEditorWidget.content;

        let jumper = new FileEditorJumper(fileEditorWidget, jump_history, documentManager);
        let editor = fileEditor.editor;

        let position = editor.getCursorPosition();
        let token = editor.getTokenForPosition(position);

        jumper.jump_to_definition({token, origin: null})
      },
      isEnabled: isEnabled(fileEditorTracker)
    });

    app.commands.addCommand(cmdIds.jumpBackFileEditor, {
      label: 'Jump back',
      execute: () => {
        let fileEditorWidget = fileEditorTracker.currentWidget;

        let jumper = new FileEditorJumper(fileEditorWidget, jump_history, documentManager);
        jumper.jump_back()
      },
      isEnabled: isEnabled(fileEditorTracker)
    });

    const bindings = [
      {
        selector: '.jp-Notebook.jp-mod-editMode',
        keys: ['Ctrl Alt B'],
        command: cmdIds.jumpNotebook
      },
      {
        selector: '.jp-Notebook',
        keys: ['Alt O'],
        command: cmdIds.jumpBackNotebook
      },
      {
        selector: '.jp-FileEditor',
        keys: ['Ctrl Alt B'],
        command: cmdIds.jumpFileEditor
      },
      {
        selector: '.jp-FileEditor',
        keys: ['Alt O'],
        command: cmdIds.jumpBackFileEditor
      },
    ];


    bindings.map(binding => app.commands.addKeyBinding(binding));

  },
  autoStart: true
};


/**
 * Export the plugin as default.
 */
export default plugin;
