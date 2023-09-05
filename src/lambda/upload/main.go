package main

import (
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
	"strings"
	"text/template"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

const HtmlTemplate = `
<!DOCTYPE html>
<html>
<body>

<form action="/upload" method="post" enctype="multipart/form-data">
  Select file to upload:
  <input type="file" name="file" id="file">
  <input type="submit" value="Upload Image" name="submit">
</form>

<h2>Files:</h2>
<ul>
{{range .Files}}
  <li>{{.}}</li>
{{end}}
</ul>

<p>Running as user: {{.User}} (UID: {{.Uid}}, GID: {{.Gid}})</p>

</body>
</html>
`

func main() {
	t := template.New("template")
	templates := template.Must(t.Parse(HtmlTemplate))

	lambda.Start(func(evt events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
		return Handler(evt, templates)
	})
}

func Handler(req events.APIGatewayProxyRequest, tmpl *template.Template) (events.APIGatewayProxyResponse, error) {
	const dir = "/mnt/efs/apps/"

	err := createDirIfNotExist(dir)
	if err != nil {
		return events.APIGatewayProxyResponse{
			StatusCode: 500,
			Body:       "Failed to ensure directory existence",
		}, nil
	}

	files, err := getFiles(dir)
	if err != nil {
		return events.APIGatewayProxyResponse{
			StatusCode: 500,
			Body:       "Failed to get file list",
		}, nil
	}

	switch {
	case req.HTTPMethod == "GET" && strings.HasSuffix(req.Path, "/upload"):
		uid := fmt.Sprint(os.Getuid())
		gid := fmt.Sprint(os.Getgid())
		user := os.Getenv("USER")

		return events.APIGatewayProxyResponse{
			StatusCode: 200,
			Headers:    map[string]string{"content-type": "text/html"},
			Body:       renderForm(tmpl, user, uid, gid, files),
		}, nil

	case req.HTTPMethod == "POST" && strings.HasSuffix(req.Path, "/upload"):
		fileContent := req.Body
		filename, ok := req.MultiValueQueryStringParameters["filename"]
		if !ok || len(filename) == 0 {
			// Handle the error, for example, by returning an error response
			return events.APIGatewayProxyResponse{
				StatusCode: 400,
				Body:       "No filename provided",
			}, nil
		}
		err := saveFile(dir, filename[0], fileContent)

		if err != nil {
			return events.APIGatewayProxyResponse{
				StatusCode: 500,
				Body:       "Failed to save file",
			}, nil
		}
		return events.APIGatewayProxyResponse{
			StatusCode: 200,
			Body:       "File saved",
		}, nil

	}

	return events.APIGatewayProxyResponse{}, nil
}

func createDirIfNotExist(dir string) error {
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return os.MkdirAll(dir, 0755)
	}
	return nil
}

func saveFile(dir string, filename string, content string) error {
	// You may want to create a unique filename, this is just an example
	fullPath := filepath.Join(dir, filename)
	return ioutil.WriteFile(fullPath, []byte(content), 0644)
}

func getFiles(dir string) ([]string, error) {
	files, err := ioutil.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	fileNames := make([]string, len(files))
	for i, file := range files {
		fileNames[i] = file.Name()
	}
	return fileNames, nil
}

func renderForm(tmpl *template.Template, user, uid, gid string, files []string) string {
	data := struct {
		User  string
		Uid   string
		Gid   string
		Files []string
	}{
		User:  user,
		Uid:   uid,
		Gid:   gid,
		Files: files,
	}

	var tpl strings.Builder
	if err := tmpl.Execute(&tpl, data); err != nil {
		return "An error occurred rendering the form"
	}
	return tpl.String()
}
