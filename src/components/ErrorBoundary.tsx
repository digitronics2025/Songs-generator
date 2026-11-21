import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Uncaught application error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#F8F8F6] px-6 text-[#141413]">
          <div className="max-w-lg rounded-xl border border-[#FECACA] bg-white p-6">
            <h1 className="text-lg font-semibold text-[#991B1B]">
              Application Error
            </h1>
            <p className="mt-2 text-sm text-[#57554F]">
              Something went wrong while communicating with Firebase or the studio backend.
            </p>
            <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-[#FAF9F6] p-3 font-mono text-xs text-[#141413]">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#152E57]"
            >
              Reload Studio
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
