import { NextResponse } from "next/server";
import { addMissingSalt } from "@/lib/cleanJsonData";

export async function POST(req: Request) {
  try {
    const jsonData = await req.json();

    // Validate that the request body is an array
    if (!Array.isArray(jsonData)) {
      return NextResponse.json(
        { error: "Request body must be a JSON array." },
        { status: 400 }
      );
    }

    // Process the data using the imported function
    const cleanedData = addMissingSalt(jsonData);

    // Send the cleaned data back as a successful response
    return NextResponse.json(cleanedData, { status: 200 });
  } catch (error) {
    // Handle JSON parsing errors or other unexpected errors
    console.error("Error processing data:", error);
    return NextResponse.json(
      { error: "An internal server error occurred." },
      { status: 500 }
    );
  }
}
