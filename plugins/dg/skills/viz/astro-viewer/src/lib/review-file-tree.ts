export interface ReviewFilePath {
  path: string;
}

export interface ReviewFileTreeFileNode<T extends ReviewFilePath> {
  type: "file";
  name: string;
  file: T;
}

export interface ReviewFileTreeFolderNode<T extends ReviewFilePath> {
  type: "folder";
  name: string;
  path: string;
  children: ReviewFileTreeNode<T>[];
}

export type ReviewFileTreeNode<T extends ReviewFilePath> = ReviewFileTreeFileNode<T> | ReviewFileTreeFolderNode<T>;

export function buildReviewFileTree<T extends ReviewFilePath>(files: T[]): ReviewFileTreeFolderNode<T> {
  const root: ReviewFileTreeFolderNode<T> = {
    type: "folder",
    name: "",
    path: "",
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const segmentPath = parts.slice(0, index + 1).join("/");
      let child = node.children.find(
        (candidate): candidate is ReviewFileTreeFolderNode<T> =>
          candidate.type === "folder" && candidate.path === segmentPath,
      );
      if (!child) {
        child = {
          type: "folder",
          name: parts[index],
          path: segmentPath,
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({
      type: "file",
      name: parts.at(-1) ?? file.path,
      file,
    });
  }

  compactChildren(root);
  sortChildren(root);
  return root;
}

export function countReviewFiles<T extends ReviewFilePath>(node: ReviewFileTreeNode<T>): number {
  return node.type === "file" ? 1 : node.children.reduce((total, child) => total + countReviewFiles(child), 0);
}

function compactChildren<T extends ReviewFilePath>(node: ReviewFileTreeFolderNode<T>): void {
  node.children = node.children.map((child) => (child.type === "folder" ? compactFolder(child) : child));
}

function compactFolder<T extends ReviewFilePath>(node: ReviewFileTreeFolderNode<T>): ReviewFileTreeFolderNode<T> {
  let name = node.name;
  let current = node;
  while (current.children.length === 1 && current.children[0].type === "folder") {
    current = current.children[0];
    name = `${name}/${current.name}`;
  }
  compactChildren(current);
  return {
    type: "folder",
    name,
    path: current.path,
    children: current.children,
  };
}

function sortChildren<T extends ReviewFilePath>(node: ReviewFileTreeFolderNode<T>): void {
  node.children.sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
  for (const child of node.children) {
    if (child.type === "folder") sortChildren(child);
  }
}
