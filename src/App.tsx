function App() {
  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <header className="flex items-center px-5 h-12 border-b border-zinc-800">
        <h1 className="text-base font-semibold tracking-tight text-zinc-100">
          Refinish
        </h1>
      </header>

      <main className="flex items-center justify-center p-8" style={{ height: "calc(100vh - 3rem)" }}>
        <div className="flex flex-col items-center justify-center w-full max-w-lg rounded-xl border-2 border-dashed border-zinc-700 p-12 transition-colors hover:border-zinc-500">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-10 h-10 text-zinc-500 mb-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          <p className="text-sm text-zinc-500">Drop images here</p>
        </div>
      </main>
    </div>
  );
}

export default App;
