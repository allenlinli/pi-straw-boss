// The bundler turns a sound import into its URL; gui/notify.ts is imported by tests/notify.test.ts through a loader hook that does the same.
declare module "*.mp3" {
	const url: string;
	export default url;
}
