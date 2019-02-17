import { FileEditor } from "@jupyterlab/fileeditor";
import { IJump, IJumpPosition } from "../jump";
import { CodeJumper } from "./jumper";
import { JumpHistory } from "../history";


export class FileEditorJumper extends CodeJumper {

  editor: FileEditor;
  language: string;
  history: JumpHistory;

  constructor(editor: FileEditor, history: JumpHistory) {
    super();
    this.editor = editor;
    this.history = history;
    this.setLanguageFromMime(editor.model.mimeType);

    editor.model.mimeTypeChanged.connect((session, mimeChanged) => {
      this.setLanguageFromMime(mimeChanged.newValue)
    });
  }

  setLanguageFromMime(mime: string){
    let type = mime.replace('text/x-', '');
    switch (type) {
      case 'rsrc':
        this.language = 'R';
        break;
      default:
        this.language = type;
    }
  }

  get editors() {
    return [this.editor.editor];
  }

  jump(jump_position: IJumpPosition) {

    let { token } = jump_position;

    // TODO: this is common
    // place cursor in the line with the definition
    let position = this.editor.editor.getPositionAt(token.offset);
    this.editor.editor.setSelection({start: position, end: position});
    this.editor.editor.focus()
  }

  jump_to_definition(jump: IJump) {
    let {token} = this._findLastDefinition(jump.token, 0);

    // nothing found
    if (!token) {
      return;
    }

    this.history.store(this.editor, {token: jump.token});

    this.jump({token: token})

  }

  jump_back() {
    let previous_position = this.history.recollect(this.editor);
    if (previous_position)
      this.jump(previous_position)
  }
}
