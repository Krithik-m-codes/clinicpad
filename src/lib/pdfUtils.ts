// PDF utility functions for prescription rendering

// export const generatePDF = async (
//   element: HTMLElement,
//   filename: string = "prescription.pdf"
// ): Promise<void> => {
//   try {
//     // Dynamic import to avoid loading libraries until needed
//     const { default: html2canvas } = await import("html2canvas");
//     const { default: jsPDF } = await import("jspdf");

//     // Create a high-quality clone for PDF generation
//     const clonedElement = element.cloneNode(true) as HTMLElement;

//     // Create a temporary container for improved rendering
//     const container = document.createElement("div");
//     container.style.cssText = `
//       position: absolute;
//       left: -9999px;
//       top: 0;
//       background: white;
//       font-family: Arial, sans-serif;
//       color: black;
//       width: 210mm;
//       box-sizing: border-box;
//     `;

//     container.appendChild(clonedElement);
//     document.body.appendChild(container);

//     // Force proper colors and styling in the clone
//     const allElements = container.querySelectorAll("*");
//     allElements.forEach((elem) => {
//       const htmlElem = elem as HTMLElement;
//       const computedStyle = window.getComputedStyle(htmlElem);

//       // Ensure text is visible
//       if (
//         computedStyle.color === "rgba(0, 0, 0, 0)" ||
//         computedStyle.color === "transparent"
//       ) {
//         htmlElem.style.color = "black";
//       }

//       // Ensure backgrounds are proper
//       if (
//         computedStyle.backgroundColor === "rgba(0, 0, 0, 0)" ||
//         computedStyle.backgroundColor === "transparent"
//       ) {
//         if (
//           htmlElem.tagName.toLowerCase() === "body" ||
//           htmlElem.classList.contains("page-break")
//         ) {
//           htmlElem.style.backgroundColor = "white";
//         }
//       }

//       // Fix table borders
//       if (
//         htmlElem.tagName.toLowerCase() === "table" ||
//         htmlElem.tagName.toLowerCase() === "th" ||
//         htmlElem.tagName.toLowerCase() === "td"
//       ) {
//         htmlElem.style.border = "1px solid black";
//         htmlElem.style.borderCollapse = "collapse";
//       }
//     });

//     try {
//       // Capture with optimized settings for crisp rendering
//       const canvas = await html2canvas(clonedElement, {
//         scale: 3, // Higher scale for better quality
//         useCORS: true,
//         allowTaint: false,
//         backgroundColor: "#ffffff",
//         logging: false,
//         foreignObjectRendering: false, // Disable for better compatibility
//         removeContainer: true,
//         imageTimeout: 15000,
//         width: clonedElement.scrollWidth,
//         height: clonedElement.scrollHeight,
//         onclone: (clonedDoc: Document) => {
//           // Force all text to be black and backgrounds white
//           const style = clonedDoc.createElement("style");
//           style.textContent = `
//             * {
//               color: black !important;
//               -webkit-print-color-adjust: exact !important;
//               print-color-adjust: exact !important;
//             }
//             .page-break {
//               background: white !important;
//             }
//             table, th, td {
//               border: 1px solid black !important;
//               border-collapse: collapse !important;
//             }
//           `;
//           clonedDoc.head.appendChild(style);
//         },
//       });

//       // Create PDF with proper dimensions
//       const imgWidth = 210; // A4 width in mm
//       const pageHeight = 297; // A4 height in mm
//       const imgHeight = (canvas.height * imgWidth) / canvas.width;
//       let heightLeft = imgHeight;

//       const pdf = new jsPDF("p", "mm", "a4");
//       let position = 0;

//       // Add first page
//       pdf.addImage(
//         canvas.toDataURL("image/jpeg", 1.0),
//         "JPEG",
//         0,
//         position,
//         imgWidth,
//         imgHeight
//       );
//       heightLeft -= pageHeight;

//       // Add additional pages if needed
//       while (heightLeft >= 0) {
//         position = heightLeft - imgHeight;
//         pdf.addPage();
//         pdf.addImage(
//           canvas.toDataURL("image/jpeg", 1.0),
//           "JPEG",
//           0,
//           position,
//           imgWidth,
//           imgHeight
//         );
//         heightLeft -= pageHeight;
//       }

//       // Download the PDF
//       pdf.save(filename);
//     } finally {
//       // Clean up
//       document.body.removeChild(container);
//     }
//   } catch (error) {
//     console.error("Error generating PDF:", error);
//     throw new Error(
//       "Failed to generate PDF. Please try the print option instead."
//     );
//   }
// };

// export const printElement = (element: HTMLElement): void => {
//   const printWindow = window.open("", "_blank");
//   if (printWindow) {
//     // Get all stylesheets from the current document
//     let styles = "";
//     for (let i = 0; i < document.styleSheets.length; i++) {
//       try {
//         const styleSheet = document.styleSheets[i];
//         if (styleSheet.href) {
//           // External stylesheets
//           styles += `<link rel="stylesheet" href="${styleSheet.href}">`;
//         } else if (styleSheet.cssRules) {
//           // Inline stylesheets
//           styles += "<style>";
//           for (let j = 0; j < styleSheet.cssRules.length; j++) {
//             styles += styleSheet.cssRules[j].cssText;
//           }
//           styles += "</style>";
//         }
//       } catch (e) {
//         // Handle cross-origin stylesheet errors
//         console.warn("Could not access stylesheet:", e);
//       }
//     }

//     printWindow.document.write(`
//       <!DOCTYPE html>
//       <html>
//         <head>
//           <title>Prescription</title>
//           <meta charset="utf-8">
//           <meta name="viewport" content="width=device-width, initial-scale=1.0">
//           ${styles}
//           <style>
//             * {
//               -webkit-print-color-adjust: exact;
//               color-adjust: exact;
//               box-sizing: border-box;
//             }
//             body { 
//               margin: 0; 
//               padding: 0; 
//               font-family: Arial, sans-serif;
//               background: white;
//               font-size: 100%;
//               transform: none;
//               position: relative;
//             }
//             .page-break { 
//               page-break-after: always;
//               display: block;
//               width: 210mm;
//               min-height: 297mm;
//               margin: 0;
//               background: white;
//               position: relative;
//               transform: none;
//               top: 0;
//               left: 0;
//               font-family: Arial, sans-serif;
//             }
//             .page-break:last-child { 
//               page-break-after: auto; 
//             }
//             /* Ensure vital signs render properly */
//             .vitals-box, [class*="vitals"] {
//               border: 1px solid #ccc !important;
//               background-color: #f9f9f9 !important;
//               padding: 8px !important;
//               font-size: 11px !important;
//               display: inline-block !important;
//             }
//             /* Ensure tables render with borders */
//             table, th, td {
//               border: 1px solid #000 !important;
//               border-collapse: collapse !important;
//             }
//             /* Fix text positioning */
//             .text-field {
//               position: relative;
//               display: block;
//               text-align: left;
//             }
//             /* Ensure heart watermark renders */
//             [style*="rgba(220, 38, 38"] {
//               color: rgba(220, 38, 38, 0.3) !important;
//               opacity: 1 !important;
//             }
//             @media print {
//               @page {
//                 size: A4;
//                 margin: 0;
//               }
//               body { 
//                 margin: 0; 
//                 padding: 0;
//                 transform: none;
//                 position: relative;
//                 font-family: Arial, sans-serif;
//               }
//               .page-break { 
//                 page-break-after: always;
//                 margin: 0;
//                 padding: 15mm 20mm;
//                 width: 210mm;
//                 min-height: 297mm;
//                 position: relative;
//                 transform: none;
//                 top: 0;
//                 left: 0;
//               }
//               .page-break:last-child { 
//                 page-break-after: auto; 
//               }
//               /* Hide any controls or buttons */
//               .print\\:hidden {
//                 display: none !important;
//               }
//             }
//           </style>
//         </head>
//         <body>
//           ${element.innerHTML}
//         </body>
//       </html>
//     `);
//     printWindow.document.close();
//     printWindow.focus();

//     // Wait for content and styles to load then print
//     setTimeout(() => {
//       printWindow.print();
//       printWindow.close();
//     }, 1500);
//   }
// };
