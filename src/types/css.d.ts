// Type declarations for CSS modules
declare module "*.css" {
  const content: { [className: string]: string };
  export default content;
}

// Type declarations for side-effect CSS imports
declare module "*.css";
