import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function tw(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const formatDate = (timestamp: string) => {
  return new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const formatDateShort = (timestamp: string) => {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

export const convertImagesToBase64 = async (html: string): Promise<string> => {

  
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html;
  const images = tempDiv.querySelectorAll("img");
  for (const img of Array.from(images)) {
    try {

      // Skip if already base64
      if (img.src.startsWith("data:")) {
        console.log(`✅ Image ${img.alt} is already base64, skipping`);
        continue;
      }

      // Standard conversion for other images
      // For static builds, handle Next.js optimized image paths
      let imageSrc = img.src;
      if (imageSrc.includes("/_next/")) {
        // This is a Next.js optimized image, try to get the original
        const originalPath = imageSrc.match(/url=([^&]+)/)?.[1];
        if (originalPath) {
          imageSrc = decodeURIComponent(originalPath);

        } 
      }

      // Create a canvas to convert image to base64
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const tempImg = document.createElement("img") as HTMLImageElement;

      // Wait for image to load
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Image load timeout"));
        }, 10000); // Increased timeout for static builds

        tempImg.onload = () => {
          clearTimeout(timeout);
          // console.log(
          //   `Image loaded successfully: ${img.alt}, size: ${tempImg.naturalWidth}x${tempImg.naturalHeight}`
          // );
          resolve();
        };
        tempImg.onerror = (e) => {
          clearTimeout(timeout);
          console.error(`Image failed to load: ${img.alt}`, e);
          reject(e);
        };

        // Don't set crossOrigin for local static files
        if (
          !imageSrc.startsWith(window.location.origin) &&
          !imageSrc.startsWith("/")
        ) {
          tempImg.crossOrigin = "anonymous";
        }

        // Handle relative paths by making them absolute
        if (imageSrc.startsWith("/")) {
          tempImg.src = window.location.origin + imageSrc;
          console.log(`Using absolute path: ${tempImg.src}`);
        } else {
          tempImg.src = imageSrc;
          console.log(`Using original path: ${tempImg.src}`);
        }
      });

      // Set canvas size - ensure minimum size for visibility
      const width = Math.max(tempImg.naturalWidth || 120, 120);
      const height = Math.max(tempImg.naturalHeight || 120, 120);
      canvas.width = width;
      canvas.height = height;
      console.log(`Canvas size: ${canvas.width}x${canvas.height}`);

      // Fill with white background for SVGs
      if (ctx) {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tempImg, 0, 0, width, height);
      }

      // Convert to base64 - use PNG for better quality with SVGs
      const dataURL = canvas.toDataURL("image/png");
      const originalSrc = img.src;
      img.src = dataURL;

      console.log(
        `✅ Successfully converted ${
          img.alt || "image"
        } from ${originalSrc} to base64 (${dataURL.length} chars)`
      );
    } catch (error) {
      console.warn(`❌ Failed to convert image ${img.src} to base64:`, error);
      // Standard fallback for other images
      if (img.src.startsWith("/")) {
        img.src = window.location.origin + img.src;
        console.log(`Applied fallback absolute path: ${img.src}`);
      }
    }
  }

  console.log("✅ Image conversion completed successfully");
  return tempDiv.innerHTML;
};

// Helper function to format food timing
export const formatFoodTiming = (foodTiming: string) => {
  switch (foodTiming) {
    case "before":
      return "Before Food";
    case "after":
      return "After Food";
    case "with":
      return "With Food";
    case "without":
      return "Without Food";
    default:
      return "-";
  }
};
