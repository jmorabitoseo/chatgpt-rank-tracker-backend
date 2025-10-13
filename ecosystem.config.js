module.exports = {
    apps: [
      {
        name: "enqueue",
        script: "./src/server.js",
        watch: ["src"], // only watch src/
        ignore_watch: ["node_modules", ".git"],
        watch_delay: 1000, // debounce restarts by 1s
      },
      {
        name: "worker",
        script: "./src/worker.js",
        watch: ["src"],
        ignore_watch: ["node_modules", ".git"],
      },
      {
        name: "dataforseo-worker",
        script: "./src/dataForSeoWorker.js",
        watch: ["src"],
        ignore_watch: ["node_modules", ".git"],
      },
      // {
      //   name: "nightly",
      //   script: "./src/nightly.js",
      //   watch: ["src"],
      //   ignore_watch: ["node_modules", ".git"],
      // },
    ],
  };