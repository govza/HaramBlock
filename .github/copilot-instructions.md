# Project Overview
This project is a browser extension designed to enhance user experience by blocking unwanted content and providing AI-driven media processing capabilities. The extension processes images and videos on web pages, applying AI predictions to filter or style content based on user preferences.

## Folder Structure
- **entrypoints/content/**: Contains the main content scripts that interact with web pages.
- **entrypoints/background/**: Contains background scripts that manage the extension's lifecycle and state.
- **entrypoints/popup/**: Contains the popup UI for user interactions.
- **hooks/**: Contains hooks for various events and actions within the extension.

## Libraries and Dependencies
- wxt: A library for managing state and interactions within the extension.
- wxt-hooks: Provides hooks for managing side effects and state changes.
- React: Used for building the popup UI and managing user interactions.
- TypeScript: The primary language for developing the extension, providing type safety and modern JavaScript features.
- Vite: A build tool that compiles the TypeScript code and bundles the extension for deployment.
- Tailwind CSS: A utility-first CSS framework used for styling the popup UI.
- TensorFlow.js: Used for running AI models directly in the browser to process images and videos.

## Coding Standards
- Use TypeScript for all new code to ensure type safety and maintainability.
- Follow the project's existing coding style, including naming conventions and file organization.
- Use arrow functions for callbacks and event handlers to maintain lexical `this` context.
- Don't provide explanations or comments in the code unless necessary for clarity.

## Environment
- The extension is designed to run in modern browsers that support WebExtensions APIs.
- Use powershell commands for building and testing the extension.
- Use pnpm for managing dependencies and running scripts.
- Use `test:unit` command to run unit tests.
- Use pnpm build to compile the extension for production.
- Don't use `pnpm dev` for development; instead, use `pnpm build` to compile the extension.
- For debugging use `pnpm build --mode development` and than start the mcp server {"url": "https://govza.github.io/gallery?level=unsafe&size=large&count=1&isOverlay=false&isNatural=true" }
- You can run browser build in development mode using `pnpm build --mode development` to check the consola logs for debugging.
- Use the `logger` utility for logging messages in the content scripts and background scripts.