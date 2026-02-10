import { useEffect, useState } from "react";

export interface ToastMessage {
  id: number;
  type: "success" | "error";
  text: string;
}

let toastId = 0;
let addToastFn: ((msg: Omit<ToastMessage, "id">) => void) | null = null;

/** Show a toast from anywhere in the app. */
export function showToast(type: "success" | "error", text: string) {
  addToastFn?.({ type, text });
}

/** Toast container — mount once at the app root. */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    addToastFn = (msg) => {
      const id = ++toastId;
      setToasts((prev) => [...prev, { ...msg, id }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3000);
    };
    return () => {
      addToastFn = null;
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-3 left-3 right-3 flex flex-col gap-1.5 z-50 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto px-3 py-2 rounded-md text-xs font-medium shadow-lg transition-all animate-[fadeIn_0.15s_ease-out] ${
            toast.type === "success"
              ? "bg-green-600 text-white"
              : "bg-red-600 text-white"
          }`}
        >
          {toast.type === "success" ? "\u2713 " : "\u2717 "}
          {toast.text}
        </div>
      ))}
    </div>
  );
}
