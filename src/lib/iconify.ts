import { addCollection } from "@iconify/react";
import { icons as flagpackIcons } from "@iconify-json/flagpack";

// Register the flag set locally so flagpack:* icons are bundled with the app
// instead of being fetched from the public Iconify API at runtime.
addCollection(flagpackIcons);
