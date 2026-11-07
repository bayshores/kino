import {Component} from "react";

export class EditorBoundary extends Component {
  state = {error: null};
  static getDerivedStateFromError(error) {return {error};}
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="startup">
      <div className="wordmark">kino</div>
      <p>{this.props.viewer ? "This file could not be displayed. Try reopening the link." : "The editor encountered an error. Your saved file and browser recovery copy are still available."}</p>
      <p role="alert">{this.state.error.message || "Could not display the editor."}</p>
      <button className="primary" onClick={() => location.reload()}>{this.props.viewer ? "Reload viewer" : "Reload editor"}</button>
    </main>;
  }
}
