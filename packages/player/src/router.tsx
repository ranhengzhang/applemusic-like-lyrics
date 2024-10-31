import {
	Route,
	createBrowserRouter,
	createRoutesFromElements,
} from "react-router-dom";
import ErrorPage from "./pages/error/index.tsx";

export const router = createBrowserRouter(
	createRoutesFromElements(
		<>
			<Route
				path="/"
				lazy={() => import("./pages/main")}
				errorElement={<ErrorPage />}
			/>
			<Route path="/settings" lazy={() => import("./pages/settings")} />
			<Route path="/playlist/:id" lazy={() => import("./pages/playlist")} />
			<Route path="/song/:id" lazy={() => import("./pages/song")} />
			<Route
				path="/amll-dev/mg-edit"
				lazy={() => import("./pages/amll-dev/mg-edit")}
			/>
			<Route path="/amll-dev" lazy={() => import("./pages/amll-dev")} />
			<Route path="/ws">
				<Route path="recv" lazy={() => import("./pages/ws/recv")} />
				<Route path="send" lazy={() => import("./pages/ws/send")} />
			</Route>
		</>,
	),
);
