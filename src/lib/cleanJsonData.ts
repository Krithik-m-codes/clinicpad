// Define an interface to describe the shape of your objects.
// import jsonData from "@/data/data.json";
// The '?' makes the 'salt' property optional.
interface DataObject {
  id: string;
  name: string;
  salt?: string;
}

/**
 * Ensures every object in an array has a 'salt' property.
 * If 'salt' is missing, it's added with an empty string value.
 *
 * @param {DataObject[]} dataArray - The array of objects to process.
 * @returns {DataObject[]} The mutated array.
 */
export function addMissingSalt(dataArray: DataObject[]): DataObject[] {
  for (const obj of dataArray) {
    // A robust check to see if the object truly lacks the 'salt' key.
    if (!obj.hasOwnProperty("salt")) {
      obj.salt = "";
    }
    // If 'salt' exists but is undefined or null, set it to an empty string.
    else if (obj.salt == null) {
      obj.salt = "";
    }
    // if salt exists and is not a string, convert to string
    else if (typeof obj.salt !== "string") {
      obj.salt = String(obj.salt);
    }
  }
  return dataArray;
}

// example usage
// console.log("Before:", jsonData);
// const cleanedData = addMissingSalt(jsonData);
// console.log("After:", cleanedData);
